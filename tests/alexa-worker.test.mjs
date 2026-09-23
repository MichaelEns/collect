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
  assert.match(linked.response.outputSpeech.text, /collection is linked/);
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
