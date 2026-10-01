import 'reflect-metadata';
import {
  SubjectAlternativeNameExtension,
  X509Certificate,
  cryptoProvider,
} from '@peculiar/x509';
import doorables from '../../alexa/lambda/doorables.js';
import { canContribute, progressKey, resolveAccess } from './access.js';
import { mergeAll } from './merge.js';
import {
  dashboardDirective,
  setDirective,
  supportsApl,
} from './visuals.js';
import { updateCollectionWidget } from './widget.js';

const {
  DoorablesError,
  DoorablesService,
  figureCodesSpeech,
  lookupSpeech,
  needSpeech,
  normaliseCapsuleCode,
  normaliseFamilyCode,
  resolvePackage,
} = doorables;

const CERTIFICATE_HOST = 's3.amazonaws.com';
const CERTIFICATE_PATH = '/echo.api/';
const CERTIFICATE_CACHE_MS = 6 * 60 * 60 * 1000;
const REQUEST_MAX_AGE_MS = 150 * 1000;
const MAX_REQUEST_BYTES = 100 * 1024;
const certificateCache = new Map();

const workerFetch = (url, options = {}) => {
  const { timeout, ...requestOptions } = options;
  return fetch(url, requestOptions);
};
const service = new DoorablesService({ fetch: workerFetch });

class AlexaRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function base64Bytes(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function validateCertificateUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AlexaRequestError(401, 'Invalid Alexa certificate URL.');
  }
  if (url.protocol !== 'https:' || url.hostname !== CERTIFICATE_HOST ||
      (url.port && url.port !== '443') ||
      !url.pathname.startsWith(CERTIFICATE_PATH) ||
      url.username || url.password || url.search || url.hash) {
    throw new AlexaRequestError(401, 'Untrusted Alexa certificate URL.');
  }
  return url;
}

async function certificateFor(rawUrl) {
  const url = validateCertificateUrl(rawUrl);
  const cached = certificateCache.get(url.href);
  if (cached && cached.expiresAt > Date.now()) return cached.certificate;

  // The certificate URL is restricted to Amazon's private echo.api S3 bucket,
  // so TLS plus bucket ownership is the trust anchor for the returned leaf.
  const response = await fetch(url.href, { redirect: 'manual' });
  if (!response.ok) {
    throw new AlexaRequestError(401, 'Alexa certificate could not be loaded.');
  }
  const pem = await response.text();
  const match = pem.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
  if (!match) throw new AlexaRequestError(401, 'Alexa certificate was invalid.');

  cryptoProvider.set(globalThis.crypto);
  const certificate = new X509Certificate(match[0]);
  const now = Date.now();
  if (certificate.notBefore.getTime() > now || certificate.notAfter.getTime() < now) {
    throw new AlexaRequestError(401, 'Alexa certificate was expired or not yet valid.');
  }
  const san = certificate.getExtension(SubjectAlternativeNameExtension);
  const isAlexaCertificate = san && san.names.items.some(
    (name) => name.type === 'dns' && name.value === 'echo-api.amazon.com');
  if (!isAlexaCertificate) {
    throw new AlexaRequestError(401, 'Alexa certificate identity was invalid.');
  }

  certificateCache.set(url.href, {
    certificate,
    expiresAt: Math.min(certificate.notAfter.getTime(), now + CERTIFICATE_CACHE_MS),
  });
  return certificate;
}

async function verifyAlexaRequest(request, rawBody, envelope, expectedSkillId) {
  const certificateUrl = request.headers.get('SignatureCertChainUrl');
  const signatureHeader = request.headers.get('Signature');
  if (!certificateUrl || !signatureHeader) {
    throw new AlexaRequestError(401, 'Alexa signature headers were missing.');
  }

  const certificate = await certificateFor(certificateUrl);
  const publicKey = await certificate.publicKey.export({
    name: 'RSASSA-PKCS1-v1_5',
    hash: 'SHA-1',
  }, ['verify'], globalThis.crypto);
  const valid = await crypto.subtle.verify(
    { name: 'RSASSA-PKCS1-v1_5' },
    publicKey,
    base64Bytes(signatureHeader),
    new TextEncoder().encode(rawBody));
  if (!valid) throw new AlexaRequestError(401, 'Alexa request signature was invalid.');

  const timestamp = Date.parse(envelope && envelope.request && envelope.request.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > REQUEST_MAX_AGE_MS) {
    throw new AlexaRequestError(400, 'Alexa request timestamp was outside the allowed window.');
  }

  const applicationId = envelope.context && envelope.context.System &&
    envelope.context.System.application &&
    envelope.context.System.application.applicationId ||
    envelope.session && envelope.session.application &&
    envelope.session.application.applicationId;
  if (!expectedSkillId || applicationId !== expectedSkillId) {
    throw new AlexaRequestError(403, 'Alexa application ID did not match.');
  }
}

function rawSlot(envelope, name) {
  const slots = envelope.request && envelope.request.intent &&
    envelope.request.intent.slots || {};
  return slots[name] && slots[name].value;
}

function resolvedSlot(envelope, name) {
  const slots = envelope.request && envelope.request.intent &&
    envelope.request.intent.slots || {};
  const slot = slots[name];
  const authorities = slot && slot.resolutions &&
    slot.resolutions.resolutionsPerAuthority;
  const values = authorities && authorities[0] && authorities[0].values;
  return values && values[0] ? values[0].value.name : rawSlot(envelope, name);
}

function resolvedSlotValues(envelope, name) {
  const slots = envelope.request && envelope.request.intent &&
    envelope.request.intent.slots || {};
  const slot = slots[name];
  const authorities = slot && slot.resolutions &&
    slot.resolutions.resolutionsPerAuthority || [];
  const resolved = authorities.flatMap((authority) =>
    (authority.values || []).map((entry) => entry.value && entry.value.name));
  return [...new Set([...resolved, rawSlot(envelope, name)].filter(Boolean))];
}

function capsuleCodeValues(envelope) {
  const raw = rawSlot(envelope, 'capsuleCode');
  const rawCode = normaliseCapsuleCode(raw);
  const resolved = resolvedSlotValues(envelope, 'capsuleCode');
  const safeResolved = resolved.filter((value) => {
    const resolvedCode = normaliseCapsuleCode(value);
    if (!rawCode || !resolvedCode || resolvedCode === rawCode) {
      return resolvedCode === rawCode;
    }
    const rawNumber = rawCode.match(/^(\d+)$/);
    const resolvedLetterCode = resolvedCode.match(/^[A-Z]+(\d+)$/);
    return Boolean(rawNumber && resolvedLetterCode &&
      rawNumber[1] === resolvedLetterCode[1]);
  });
  return [...new Set([raw, ...safeResolved].filter(Boolean))];
}

function codeFromPackageSlot(envelope) {
  const raw = rawSlot(envelope, 'package');
  const tokens = String(raw || '').match(/[a-z]+|\d+/gi) || [];
  for (let length = Math.min(4, tokens.length); length > 0; length -= 1) {
    const suffix = tokens.slice(-length).join(' ');
    if (!normaliseCapsuleCode(suffix)) continue;
    const packageText = tokens.slice(0, -length).join(' ');
    if (resolvePackage(packageText).status === 'ok') return suffix;
  }

  return undefined;
}

function spokenList(items) {
  if (items.length < 2) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function capsuleCodeSlot(envelope) {
  const letter = rawSlot(envelope, 'codeLetter') ||
    resolvedSlot(envelope, 'codeLetter');
  const number = rawSlot(envelope, 'codeNumber') ||
    resolvedSlot(envelope, 'codeNumber');
  if (letter && number) return `${letter} ${number}`;
  const values = capsuleCodeValues(envelope);
  if (values.length) return values.length > 1 ? values : values[0];
  if (number) return number;
  const packageCode = codeFromPackageSlot(envelope);
  if (packageCode) return packageCode;
  return values.length > 1 ? values : values[0];
}

function alexaResponse(
  speech,
  reprompt,
  sessionAttributes = {},
  directives = [],
) {
  const result = {
    version: '1.0',
    sessionAttributes,
    response: {
      outputSpeech: { type: 'PlainText', text: speech },
      shouldEndSession: !reprompt && directives.length === 0,
    },
  };
  if (directives.length) result.response.directives = directives;
  if (reprompt) {
    result.response.reprompt = {
      outputSpeech: { type: 'PlainText', text: reprompt },
    };
  }

  return result;
}

async function visualForDashboard(envelope, env, access, queryService) {
  const progress = await readProgress(env, access);
  try {
    await updateCollectionWidget(
      envelope,
      env,
      queryService,
      progress,
      access,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown failure';
    console.warn(`Alexa widget refresh failed: ${detail}`);
  }
  if (!supportsApl(envelope)) return [];
  return [await dashboardDirective(queryService, progress, access)];
}

async function refreshWidget(envelope, env, access, progress, queryService) {
  try {
    await updateCollectionWidget(
      envelope,
      env,
      queryService,
      progress,
      access,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown failure';
    console.warn(`Alexa widget refresh failed: ${detail}`);
  }
}

async function toggleFigure(env, access, setId, figureId, queryService) {
  if (!canContribute(access)) return readProgress(env, access);
  const current = await readProgress(env, access);
  const sets = await queryService.collectionSets(current);
  const set = sets.find((item) => item.id === setId);
  const figure = set && set.figures.find((item) => item.id === figureId);
  if (!figure) {
    throw new DoorablesError('invalid-figure', 'That figure was not found.');
  }
  const previous = current[setId] && current[setId][figureId] || {};
  const incoming = {
    [setId]: {
      [figureId]: {
        have: !figure.have,
        dupes: Number(previous.dupes) || 0,
        codes: Array.isArray(previous.codes) ? previous.codes : [],
        updatedAt: Date.now(),
      },
    },
  };
  const merged = mergeAll(current, incoming, Date.now());
  await env.COLLECT.put(
    progressKey(access.collectionCode),
    JSON.stringify(merged),
  );
  return merged;
}

function userId(envelope) {
  return envelope.context && envelope.context.System &&
    envelope.context.System.user && envelope.context.System.user.userId ||
    envelope.session && envelope.session.user && envelope.session.user.userId;
}

async function userKey(envelope) {
  const id = userId(envelope);
  if (!id) throw new DoorablesError('invalid-user', 'Alexa user ID was missing.');
  const digest = await crypto.subtle.digest(
    'SHA-256', new TextEncoder().encode(id));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `alexa-user:${hash}`;
}

function emptyLinks() {
  return { version: 2, activeCode: '', collections: [] };
}

async function linkedCollections(envelope, env) {
  const raw = await env.COLLECT.get(await userKey(envelope));
  if (!raw) return emptyLinks();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 2 && Array.isArray(parsed.collections)) {
      return {
        version: 2,
        activeCode: String(parsed.activeCode || ''),
        collections: parsed.collections
          .filter((item) => item && typeof item.code === 'string')
          .map((item) => ({
            code: item.code,
            name: String(item.name || 'My Collection').slice(0, 60),
            role: ['owner', 'contributor', 'viewer'].includes(item.role)
              ? item.role
              : 'viewer',
          })),
      };
    }
  } catch { /* a v1 value is the raw four-word code */ }
  return {
    version: 2,
    activeCode: raw,
    collections: [{ code: raw, name: "Joe's Collection", role: 'owner' }],
  };
}

async function saveLinkedCollections(envelope, env, links) {
  await env.COLLECT.put(await userKey(envelope), JSON.stringify(links));
}

async function activeCollection(envelope, env) {
  const links = await linkedCollections(envelope, env);
  if (!links.collections.length) return { links, access: null };
  const linked = links.collections.find((item) => item.code === links.activeCode) ||
    links.collections[0];
  const access = await resolveAccess(env, linked.code);
  if (!access) {
    throw new DoorablesError('invalid-code', 'The linked sharing code no longer works.');
  }
  return { links, access };
}

async function readProgress(env, access) {
  const raw = await env.COLLECT.get(progressKey(access.collectionCode));
  if (raw === null) {
    throw new DoorablesError('invalid-code', 'That sharing code is not allocated.');
  }
  try {
    return JSON.parse(raw) || {};
  } catch {
    throw new DoorablesError('unavailable', 'The collection data was invalid.');
  }
}

function packageResolution(envelope) {
  const spoken = resolvePackage(rawSlot(envelope, 'package'));
  return spoken.status === 'unknown'
    ? resolvePackage(resolvedSlot(envelope, 'package'))
    : spoken;
}

function rememberPackageQuestion(
  sessionAttributes, resolution, operation, capsuleCode, figure) {
  sessionAttributes.pendingPackage = {
    kind: resolution.kind,
    choices: resolution.choices,
    operation,
    capsuleCode,
    figure,
  };
}

async function answerNeed(env, access, packageInfo, sessionAttributes, queryService) {
  const progress = await readProgress(env, access);
  const result = await queryService.countNeeded(packageInfo, progress);
  return alexaResponse(needSpeech(result), undefined, sessionAttributes);
}

async function answerLookup(
  env, access, packageInfo, capsuleCode, sessionAttributes, queryService) {
  const progress = await readProgress(env, access);
  try {
    const result = await queryService.lookup(packageInfo, capsuleCode, progress);
    return alexaResponse(lookupSpeech(result), undefined, sessionAttributes);
  } catch (error) {
    if (error instanceof DoorablesError && error.code === 'invalid-capsule-code') {
      return alexaResponse(
        'I did not understand that package code. Please say the letter and number again.',
        undefined, sessionAttributes);
    }
    throw error;
  }
}

async function answerFigureCodes(
  env, access, packageInfo, figure, sessionAttributes, queryService) {
  await readProgress(env, access);
  const result = await queryService.findFigureCodes(packageInfo, figure);
  return alexaResponse(figureCodesSpeech(result), undefined, sessionAttributes);
}

export async function handleAlexaEnvelope(
  envelope, env, queryService = service) {
  const request = envelope.request || {};
  const requestType = request.type;
  const intentName = request.intent && request.intent.name;
  const sessionAttributes = { ...envelope.session && envelope.session.attributes };

  try {
    if (requestType === 'LaunchRequest') {
      const { links, access } = await activeCollection(envelope, env);
      const speech = access
        ? `${access.name} is selected. Ask how many red Death Star figures Joe needs, ` +
          'or ask what is in gray Death Star code I 8.'
        : 'First link Joe\'s collection. Say, use sharing code, followed by the four words.';
      return alexaResponse(
        speech,
        'What would you like to know?',
        { ...sessionAttributes, linkedCollectionCount: links.collections.length },
        access
          ? await visualForDashboard(envelope, env, access, queryService)
          : [],
      );
    }

    if (requestType === 'SessionEndedRequest') {
      return { version: '1.0', response: {} };
    }

    if (requestType === 'Alexa.DataStore.PackageManager.UsagesInstalled' ||
        requestType === 'Alexa.DataStore.PackageManager.UpdateRequest') {
      const { access } = await activeCollection(envelope, env);
      if (access) {
        await refreshWidget(
          envelope,
          env,
          access,
          await readProgress(env, access),
          queryService,
        );
      }
      return { version: '1.0', response: {} };
    }

    if (requestType.startsWith('Alexa.DataStore.')) {
      return { version: '1.0', response: {} };
    }

    if (requestType === 'Alexa.Presentation.APL.UserEvent') {
      const { access } = await activeCollection(envelope, env);
      if (!access) {
        return alexaResponse(
          'Link a collection before opening it on this screen.',
          undefined,
          sessionAttributes,
        );
      }
      const [action, setId, figureId] = request.arguments || [];
      if (action === 'dashboard') {
        return alexaResponse(
          `Showing ${access.name}.`,
          undefined,
          sessionAttributes,
          await visualForDashboard(envelope, env, access, queryService),
        );
      }
      if (action === 'openSet') {
        const progress = await readProgress(env, access);
        return alexaResponse(
          'Opening the set.',
          undefined,
          sessionAttributes,
          [await setDirective(queryService, progress, access, setId, env)],
        );
      }
      if (action === 'toggleFigure') {
        const progress = await toggleFigure(
          env,
          access,
          setId,
          figureId,
          queryService,
        );
        await refreshWidget(envelope, env, access, progress, queryService);
        return alexaResponse(
          access.role === 'viewer'
            ? 'This sharing code can only view the collection.'
            : 'Updated.',
          undefined,
          sessionAttributes,
          [await setDirective(queryService, progress, access, setId, env)],
        );
      }
      return alexaResponse(
        'I did not understand that screen action.',
        undefined,
        sessionAttributes,
      );
    }

    if (requestType !== 'IntentRequest') {
      return alexaResponse(
        'I did not understand that request.', undefined, sessionAttributes);
    }

    if (intentName === 'LinkCollectionIntent') {
      const familyCode = normaliseFamilyCode(rawSlot(envelope, 'familyCode'));
      if (!familyCode) {
        return alexaResponse(
          'A sharing code has four words. Please say, use sharing code, followed by all four.',
          'What are the four words?', sessionAttributes);
      }
      const access = await resolveAccess(env, familyCode);
      if (!access) {
        return alexaResponse(
          'That sharing code was not recognized. Please check the four words and try again.',
          'What are the four words?', sessionAttributes);
      }
      const links = await linkedCollections(envelope, env);
      const existing = links.collections.find((item) => item.code === familyCode);
      if (existing) {
        existing.name = access.name;
        existing.role = access.role;
      } else {
        links.collections.push({
          code: familyCode,
          name: access.name,
          role: access.role,
        });
      }
      links.activeCode = familyCode;
      await saveLinkedCollections(envelope, env, links);
      await refreshWidget(
        envelope,
        env,
        access,
        await readProgress(env, access),
        queryService,
      );
      return alexaResponse(
        `${access.name} is linked and selected. I will not repeat the sharing code.`,
        undefined, sessionAttributes);
    }

    if (intentName === 'UnlinkCollectionIntent') {
      const links = await linkedCollections(envelope, env);
      const selected = links.collections.find((item) => item.code === links.activeCode) ||
        links.collections[0];
      if (!selected) {
        return alexaResponse(
          'No collection is linked to this Alexa account.',
          undefined, sessionAttributes);
      }
      links.collections = links.collections.filter((item) => item.code !== selected.code);
      links.activeCode = links.collections[0] ? links.collections[0].code : '';
      if (links.collections.length) {
        await saveLinkedCollections(envelope, env, links);
      } else {
        await env.COLLECT.delete(await userKey(envelope));
      }
      return alexaResponse(
        `${selected.name} is unlinked from this Alexa account.`,
        undefined, sessionAttributes);
    }

    if (intentName === 'UnlinkAllCollectionsIntent') {
      await env.COLLECT.delete(await userKey(envelope));
      return alexaResponse(
        'All collections are unlinked from this Alexa account.',
        undefined, sessionAttributes);
    }

    if (intentName === 'ListCollectionsIntent') {
      const links = await linkedCollections(envelope, env);
      if (!links.collections.length) {
        return alexaResponse(
          'No collection is linked yet.',
          undefined, sessionAttributes);
      }
      const names = links.collections.map((item) => item.name);
      return alexaResponse(
        names.length === 1
          ? `${names[0]} is linked.`
          : `The linked collections are ${spokenList(names)}.`,
        undefined, sessionAttributes);
    }

    if (intentName === 'SelectCollectionIntent') {
      const wanted = String(rawSlot(envelope, 'collectionName') || '')
        .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const links = await linkedCollections(envelope, env);
      const matches = links.collections.filter((item) => {
        const name = item.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        return name === wanted || name.includes(wanted) || wanted.includes(name);
      });
      if (matches.length !== 1) {
        return alexaResponse(
          matches.length
            ? 'More than one collection matched. Please use the full name.'
            : 'I could not find that linked collection.',
          undefined, sessionAttributes);
      }
      links.activeCode = matches[0].code;
      await saveLinkedCollections(envelope, env, links);
      const selectedAccess = await resolveAccess(env, matches[0].code);
      if (selectedAccess) {
        await refreshWidget(
          envelope,
          env,
          selectedAccess,
          await readProgress(env, selectedAccess),
          queryService,
        );
      }
      return alexaResponse(
        `${matches[0].name} is selected.`,
        undefined, sessionAttributes);
    }

    if (intentName === 'AMAZON.HelpIntent') {
      return alexaResponse(
        'You can ask how many red Death Star figures Joe needs, or what is in gray ' +
        'Death Star code I 8, or what code Queen Amidala is in. ' +
        'Toy Story backpacks need a color: blue, green, or purple.',
        'What would you like to know?', sessionAttributes);
    }

    if (intentName === 'AMAZON.CancelIntent' || intentName === 'AMAZON.StopIntent') {
      return alexaResponse('Goodbye.', undefined, sessionAttributes);
    }

    if (intentName === 'AMAZON.FallbackIntent') {
      return alexaResponse(
        'I can count what Joe needs or look up a package code. Include the package color.',
        'Try asking how many red Death Star figures Joe needs.', sessionAttributes);
    }

    const { access } = await activeCollection(envelope, env);
    if (!access) {
      return alexaResponse(
        'Joe\'s collection is not linked yet. Say, use sharing code, followed by the four words.',
        undefined, sessionAttributes);
    }

    if (intentName === 'PackageClarificationIntent') {
      const pending = sessionAttributes.pendingPackage;
      if (!pending) {
        return alexaResponse(
          'Please ask the whole question again, including the package color.',
          undefined, sessionAttributes);
      }
      const rawColor = resolvedSlot(envelope, 'color');
      const color = String(rawColor || '').toLowerCase().replace('grey', 'gray');
      if (!pending.choices.includes(color)) {
        const prompt = `Please choose ${pending.choices.join(', or ')}.`;
        return alexaResponse(prompt, prompt, sessionAttributes);
      }
      const resolution = resolvePackage(`${color} ${pending.kind}`);
      if (resolution.status !== 'ok') {
        return alexaResponse(
          'I could not match that color. Please ask the whole question again.',
          undefined, sessionAttributes);
      }
      delete sessionAttributes.pendingPackage;
      if (pending.operation === 'lookup') {
        return answerLookup(
          env, access, resolution.packageInfo, pending.capsuleCode,
          sessionAttributes, queryService);
      }
      if (pending.operation === 'figure-codes') {
        return answerFigureCodes(
          env, access, resolution.packageInfo, pending.figure,
          sessionAttributes, queryService);
      }
      return answerNeed(
        env, access, resolution.packageInfo, sessionAttributes, queryService);
    }

    if (intentName === 'NeedCountIntent') {
      const resolution = packageResolution(envelope);
      if (resolution.status === 'ambiguous') {
        rememberPackageQuestion(sessionAttributes, resolution, 'need');
        return alexaResponse(
          resolution.speech, resolution.speech, sessionAttributes);
      }
      if (resolution.status !== 'ok') {
        return alexaResponse(
          'I did not recognize that package. Try red Death Star, gray Death Star, ' +
          'or a blue, green, or purple Toy Story backpack.',
          undefined, sessionAttributes);
      }
      return answerNeed(
        env, access, resolution.packageInfo, sessionAttributes, queryService);
    }

    if (intentName === 'CodeLookupIntent') {
      const resolution = packageResolution(envelope);
      const capsuleCode = capsuleCodeSlot(envelope);
      if (resolution.status === 'ambiguous') {
        rememberPackageQuestion(
          sessionAttributes, resolution, 'lookup', capsuleCode);
        return alexaResponse(
          resolution.speech, resolution.speech, sessionAttributes);
      }
      if (resolution.status !== 'ok') {
        return alexaResponse(
          'I did not recognize that package. Include its color and package shape.',
          undefined, sessionAttributes);
      }
      return answerLookup(
        env, access, resolution.packageInfo, capsuleCode,
        sessionAttributes, queryService);
    }

    if (intentName === 'FigureCodeIntent') {
      const resolution = packageResolution(envelope);
      const figure = resolvedSlot(envelope, 'figure');
      if (resolution.status === 'ambiguous') {
        rememberPackageQuestion(
          sessionAttributes, resolution, 'figure-codes', undefined, figure);
        return alexaResponse(
          resolution.speech, resolution.speech, sessionAttributes);
      }
      if (resolution.status !== 'ok') {
        return alexaResponse(
          'I did not recognize that package. Include its color and package shape.',
          undefined, sessionAttributes);
      }
      return answerFigureCodes(
        env, access, resolution.packageInfo, figure,
        sessionAttributes, queryService);
    }

    return alexaResponse(
      'I did not understand that request.', undefined, sessionAttributes);
  } catch (error) {
    const code = error instanceof DoorablesError ? error.code : 'internal';
    const detail = error instanceof Error ? error.message : 'unknown failure';
    console.error(`Alexa request failed: ${code}: ${detail}`);
    if (code === 'invalid-code') {
      return alexaResponse(
        'The saved sharing code no longer works. Please link Joe\'s collection again.',
        undefined, sessionAttributes);
    }
    if (code === 'rate-limited') {
      return alexaResponse(
        'There were too many requests just now. Please try again soon.',
        undefined, sessionAttributes);
    }
    return alexaResponse(
      'I could not reach Joe\'s collection just now. Please try again in a moment.',
      undefined, sessionAttributes);
  }
}

export async function handleAlexaRequest(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405 });
  }
  const rawBody = await request.text();
  if (!rawBody || rawBody.length > MAX_REQUEST_BYTES) {
    return new Response('Invalid request body.', { status: 400 });
  }

  let envelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON.', { status: 400 });
  }

  try {
    await verifyAlexaRequest(request, rawBody, envelope, env.ALEXA_SKILL_ID);
  } catch (error) {
    const status = error instanceof AlexaRequestError ? error.status : 401;
    const message = error instanceof Error ? error.message : 'Unknown verification error.';
    console.warn(`Alexa verification failed with status ${status}: ${message}`);
    return new Response('Unauthorized Alexa request.', { status });
  }

  return new Response(JSON.stringify(await handleAlexaEnvelope(envelope, env)), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export { validateCertificateUrl };
