import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleAlexaEnvelope,
  validateCertificateUrl,
} from '../worker/src/alexa.js';
import { createSignedAlexaRequest } from '../worker/test/alexa-signing.js';
import worker from '../worker/src/index.js';

const SKILL_ID = 'amzn1.ask.skill.00cc0524-8f23-4c1b-b8a9-1b20e6d1631c';
const FAMILY_CODE = 'foxglove-lizard-donut-donut';

class MemoryKv {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  async get(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

function environment(entries = []) {
  return {
    ALEXA_SKILL_ID: SKILL_ID,
    COLLECT: new MemoryKv(entries),
  };
}

function envelope(intentName, slots = {}, attributes = {}) {
  return {
    version: '1.0',
    session: {
      application: { applicationId: SKILL_ID },
      attributes,
      user: { userId: 'amzn1.ask.account.test-family' },
    },
    context: {
      System: {
        application: { applicationId: SKILL_ID },
        user: { userId: 'amzn1.ask.account.test-family' },
      },
    },
    request: {
      type: 'IntentRequest',
      timestamp: new Date().toISOString(),
      intent: {
        name: intentName,
        slots: Object.fromEntries(Object.entries(slots).map(([name, value]) => [
          name,
          { name, value },
        ])),
      },
    },
  };
}

function aplEnvelope(request, attributes = {}) {
  const result = envelope('AMAZON.HelpIntent', {}, attributes);
  result.context.System.device = {
    supportedInterfaces: {
      'Alexa.Presentation.APL': {},
    },
  };
  result.request = {
    timestamp: new Date().toISOString(),
    ...request,
  };
  return result;
}

function resolvedSlot(name, value, resolutions) {
  return {
    name,
    value,
    resolutions: {
      resolutionsPerAuthority: [{
        status: { code: 'ER_SUCCESS_MATCH' },
        values: resolutions.map((resolution) => ({
          value: { name: resolution },
        })),
      }],
    },
  };
}

test('Alexa endpoint refuses unsigned requests', async () => {
  const request = new Request('https://worker.example/alexa', {
    method: 'POST',
    body: JSON.stringify(envelope('AMAZON.HelpIntent')),
  });
  const response = await worker.fetch(request, environment());
  assert.equal(response.status, 401);
});

test('Alexa endpoint accepts a correctly signed fresh request', async () => {
  const certificateUrl =
    'https://s3.amazonaws.com/echo.api/echo-api-cert-unit-test.pem';
  const signed = await createSignedAlexaRequest(
    'https://worker.example/alexa',
    envelope('AMAZON.HelpIntent'),
    certificateUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), certificateUrl);
    return new Response(signed.certificatePem);
  };
  try {
    const response = await worker.fetch(signed.request, environment());
    assert.equal(response.status, 200);
    assert.match(
      (await response.json()).response.outputSpeech.text,
      /what code Queen Amidala is in/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Alexa certificate URL validation accepts only the Amazon echo certificate path', () => {
  assert.equal(
    validateCertificateUrl(
      'https://s3.amazonaws.com/echo.api/echo-api-cert-123.pem').hostname,
    's3.amazonaws.com');
  assert.throws(
    () => validateCertificateUrl('https://example.com/echo.api/cert.pem'));
  assert.throws(
    () => validateCertificateUrl(
      'https://s3.amazonaws.com/echo.api/cert.pem?redirect=example'));
});

test('Alexa pairing persists by hashed user ID and supports a later need query', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, JSON.stringify({
    'sw-galaxy-peek-s2': { amidala: { have: true } },
  })]]);
  const queryService = {
    async countNeeded(packageInfo, progress) {
      assert.equal(packageInfo.label, 'red Death Star');
      assert.equal(progress['sw-galaxy-peek-s2'].amidala.have, true);
      return { label: packageInfo.label, total: 25, missing: 24 };
    },
  };

  const linked = await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    queryService);
  assert.match(linked.response.outputSpeech.text, /is linked and selected/i);
  const storedKeys = [...env.COLLECT.values.keys()]
    .filter((key) => key.startsWith('alexa-user:'));
  assert.equal(storedKeys.length, 1);
  assert.ok(!storedKeys[0].includes('test-family'));

  const answer = await handleAlexaEnvelope(
    envelope('NeedCountIntent', { package: 'red Death Star' }),
    env,
    queryService);
  assert.equal(
    answer.response.outputSpeech.text,
    'Joe needs 24 of the 25 red Death Star figures.');
});

test('Alexa upgrades a legacy raw linked code without making the user pair again', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {},
  );
  const userKey = [...env.COLLECT.values.keys()]
    .find((key) => key.startsWith('alexa-user:'));
  await env.COLLECT.put(userKey, FAMILY_CODE);

  const answer = await handleAlexaEnvelope(
    envelope('NeedCountIntent', { package: 'red Death Star' }),
    env,
    {
      async countNeeded() {
        return { label: 'red Death Star', total: 25, missing: 25 };
      },
    },
  );
  assert.equal(
    answer.response.outputSpeech.text,
    'Joe needs 25 of the 25 red Death Star figures.',
  );
});

test('Alexa links and selects independent household collections', async () => {
  const grandmaCode = 'mustang-melody-cactus-glimmer';
  const env = environment([
    [`p:${FAMILY_CODE}`, JSON.stringify({
      'sw-galaxy-peek-s2': { amidala: { have: true } },
    })],
    [`info:${FAMILY_CODE}`, JSON.stringify({ name: "Joe's Collection" })],
    [`p:${grandmaCode}`, JSON.stringify({
      'sw-galaxy-peek-s2': { rey: { have: true } },
    })],
    [`info:${grandmaCode}`, JSON.stringify({ name: "Grandma's House" })],
  ]);

  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {},
  );
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: grandmaCode }),
    env,
    {},
  );

  const listed = await handleAlexaEnvelope(
    envelope('ListCollectionsIntent'),
    env,
    {},
  );
  assert.match(listed.response.outputSpeech.text, /Joe's Collection/);
  assert.match(listed.response.outputSpeech.text, /Grandma's House/);

  const selected = await handleAlexaEnvelope(
    envelope('SelectCollectionIntent', {
      collectionName: "Grandma's House",
    }),
    env,
    {},
  );
  assert.equal(
    selected.response.outputSpeech.text,
    "Grandma's House is selected.",
  );

  await handleAlexaEnvelope(
    envelope('NeedCountIntent', { package: 'red Death Star' }),
    env,
    {
      async countNeeded(packageInfo, progress) {
        assert.equal(packageInfo.label, 'red Death Star');
        assert.equal(progress['sw-galaxy-peek-s2'].rey.have, true);
        assert.equal(progress['sw-galaxy-peek-s2'].amidala, undefined);
        return { label: packageInfo.label, total: 25, missing: 24 };
      },
    },
  );
});

test('Echo Show launch renders the selected collection dashboard', async () => {
  const env = environment([
    [`p:${FAMILY_CODE}`, JSON.stringify({
      'sw-galaxy-peek-s2': { amidala: { have: true } },
    })],
    [`info:${FAMILY_CODE}`, JSON.stringify({ name: "Joe's Collection" })],
  ]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {},
  );

  const response = await handleAlexaEnvelope(
    aplEnvelope({ type: 'LaunchRequest' }),
    env,
    {
      async collectionSets(progress) {
        assert.equal(progress['sw-galaxy-peek-s2'].amidala.have, true);
        return [{
          id: 'sw-galaxy-peek-s2',
          name: 'Galaxy Peek Series 2',
          emoji: '🔴',
          found: 1,
          total: 25,
          figures: [],
        }];
      },
    },
  );

  assert.equal(response.response.shouldEndSession, false);
  assert.equal(
    response.response.directives[0].type,
    'Alexa.Presentation.APL.RenderDocument',
  );
  assert.equal(
    response.response.directives[0].datasources.payload.title,
    "Joe's Collection",
  );
  assert.equal(
    response.response.directives[0].datasources.payload.sets[0].found,
    1,
  );
});

test('Echo Show touch toggles contributors but not viewers', async () => {
  const viewerCode = 'bluejay-sequoia-pangolin-ruby';
  const env = environment([
    [`p:${FAMILY_CODE}`, JSON.stringify({
      'sw-galaxy-peek-s2': { amidala: { have: false, updatedAt: 1 } },
    })],
    [`info:${FAMILY_CODE}`, JSON.stringify({ name: "Joe's Collection" })],
    [`share:${viewerCode}`, JSON.stringify({
      collectionCode: FAMILY_CODE,
      role: 'viewer',
      createdAt: 1,
    })],
  ]);
  const catalogue = async (progress) => [{
    id: 'sw-galaxy-peek-s2',
    name: 'Galaxy Peek Series 2',
    emoji: '🔴',
    found: progress['sw-galaxy-peek-s2'].amidala.have ? 1 : 0,
    total: 1,
    figures: [{
      id: 'amidala',
      name: 'Queen Amidala',
      rarity: 'ultra-rare',
      have: progress['sw-galaxy-peek-s2'].amidala.have,
    }],
  }];

  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {},
  );
  const touch = aplEnvelope({
    type: 'Alexa.Presentation.APL.UserEvent',
    arguments: ['toggleFigure', 'sw-galaxy-peek-s2', 'amidala'],
  });
  const changed = await handleAlexaEnvelope(touch, env, {
    collectionSets: catalogue,
  });
  assert.equal(
    changed.response.directives[0].datasources.payload.figures[0].have,
    true,
  );

  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: viewerCode }),
    env,
    {},
  );
  const unchanged = await handleAlexaEnvelope(touch, env, {
    collectionSets: catalogue,
  });
  assert.match(unchanged.response.outputSpeech.text, /only view/);
  assert.equal(
    unchanged.response.directives[0].datasources.payload.figures[0].have,
    true,
  );
});

test('Alexa reverse lookup returns figure codes through the Worker backend', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});

  const answer = await handleAlexaEnvelope(
    envelope('FigureCodeIntent', {
      figure: 'Queen Amidala',
      package: 'red Death Star',
    }),
    env,
    {
      async findFigureCodes(packageInfo, figure) {
        assert.equal(packageInfo.label, 'red Death Star');
        assert.equal(figure, 'Queen Amidala');
        return {
          status: 'ok',
          label: packageInfo.label,
          figure,
          agreed: ['A001', 'B002'],
          disputed: [],
        };
      },
    });
  assert.match(answer.response.outputSpeech.text, /codes A 001 and B 002/);
});

test('Alexa keeps alternate code resolutions when speech drops the letter', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});
  const request = envelope('CodeLookupIntent', {
    package: 'red Death Star',
    capsuleCode: 'placeholder',
  });
  request.request.intent.slots.capsuleCode =
    resolvedSlot('capsuleCode', '8', ['8', 'I8']);

  const answer = await handleAlexaEnvelope(request, env, {
    async lookup(packageInfo, code) {
      assert.equal(packageInfo.label, 'red Death Star');
      assert.deepEqual(code, ['8', 'I8']);
      return { code: 'I8', label: packageInfo.label, entries: [] };
    },
  });
  assert.match(answer.response.outputSpeech.text, /code I 8/);
});

test('Alexa ignores unrelated fuzzy package and code resolutions', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});
  const request = envelope('CodeLookupIntent', {
    package: 'ticket to fun',
    capsuleCode: 'D 22',
  });
  request.request.intent.slots.package = resolvedSlot(
    'package',
    'ticket to fun',
    ['blue Cargo Drop', 'Ticket to Fun capsule']);
  request.request.intent.slots.capsuleCode = resolvedSlot(
    'capsuleCode',
    'D 22',
    ['A1']);

  await handleAlexaEnvelope(request, env, {
    async lookup(packageInfo, code) {
      assert.equal(packageInfo.label, 'Ticket to Fun capsule');
      assert.equal(code, 'D 22');
      return { code: 'D22', label: packageInfo.label, entries: [] };
    },
  });
});

test('Alexa trusts the spoken backpack color over fuzzy package resolution order', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});
  const request = envelope('CodeLookupIntent', {
    package: 'green backpack',
    capsuleCode: '11',
  });
  request.request.intent.slots.package = resolvedSlot(
    'package',
    'green backpack',
    ['blue Toy Story backpack', 'green Toy Story backpack']);

  await handleAlexaEnvelope(request, env, {
    async lookup(packageInfo, code) {
      assert.equal(packageInfo.label, 'green Toy Story backpack');
      assert.equal(code, '11');
      return { code: '11', label: packageInfo.label, entries: [] };
    },
  });
});

test('Alexa recovers a numeric code appended to the package slot', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});
  const request = envelope('CodeLookupIntent', {
    package: 'green backpack 11',
  });

  await handleAlexaEnvelope(request, env, {
    async lookup(packageInfo, code) {
      assert.equal(packageInfo.label, 'green Toy Story backpack');
      assert.equal(code, '11');
      return { code: '11', label: packageInfo.label, entries: [] };
    },
  });
});

test('Alexa recovers a lettered code appended to the package slot', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});
  const request = envelope('CodeLookupIntent', {
    package: 'ticket to fun D 22',
  });

  await handleAlexaEnvelope(request, env, {
    async lookup(packageInfo, code) {
      assert.equal(packageInfo.label, 'Ticket to Fun capsule');
      assert.equal(code, 'D 22');
      return { code: 'D22', label: packageInfo.label, entries: [] };
    },
  });
});

test('Alexa uses a partial number slot when the letter slot is absent', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});
  const request = envelope('CodeLookupIntent', {
    package: 'green backpack',
    codeNumber: '11',
  });

  await handleAlexaEnvelope(request, env, {
    async lookup(packageInfo, code) {
      assert.equal(packageInfo.label, 'green Toy Story backpack');
      assert.equal(code, '11');
      return { code: '11', label: packageInfo.label, entries: [] };
    },
  });
});

test('Alexa combines separately recognized code letters and numbers', async () => {
  const env = environment([[`p:${FAMILY_CODE}`, '{}']]);
  await handleAlexaEnvelope(
    envelope('LinkCollectionIntent', { familyCode: FAMILY_CODE }),
    env,
    {});
  const request = envelope('CodeLookupIntent', {
    package: 'red Death Star',
    codeLetter: 'J',
    codeNumber: '8',
  });

  await handleAlexaEnvelope(request, env, {
    async lookup(packageInfo, code) {
      assert.equal(packageInfo.label, 'red Death Star');
      assert.equal(code, 'J 8');
      return { code: 'J8', label: packageInfo.label, entries: [] };
    },
  });
});
