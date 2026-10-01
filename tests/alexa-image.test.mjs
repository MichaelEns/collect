import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAlexaImage } from '../worker/src/alexa-image.js';
import {
  createImageToken,
  readImageToken,
} from '../worker/src/image-token.js';

const SECRET = 'unit-test-image-secret';
const CODE = 'foxglove-lizard-donut-donut';

class MemoryKv {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  async get(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  async getWithMetadata(key) {
    return {
      value: this.values.has(key) ? this.values.get(key) : null,
      metadata: null,
    };
  }
}

test('private image tokens conceal the collection code and expire', async () => {
  const now = Date.now();
  const token = await createImageToken(SECRET, CODE, now);
  assert.ok(token.length > 40);
  assert.equal(token.includes(CODE), false);
  assert.equal(await readImageToken(SECRET, token, now), CODE);
  const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
  assert.equal(
    await readImageToken(SECRET, tampered, now),
    null,
  );
  assert.equal(
    await readImageToken(SECRET, token, now + 16 * 60 * 1000),
    null,
  );
});

test('Alexa image links prefer the child photo over catalogue art', async () => {
  const token = await createImageToken(SECRET, CODE);
  const env = {
    ALEXA_IMAGE_SIGNING_KEY: SECRET,
    COLLECT: new MemoryKv([
      [`p:${CODE}`, '{}'],
      [`ph:${CODE}:set-a:figure-a`, new TextEncoder().encode('own').buffer],
      [`cat:${CODE}:set-a:figure-a`, new TextEncoder().encode('catalogue').buffer],
    ]),
  };
  const response = await handleAlexaImage(new Request(
    `https://worker.example/alexa/image/set-a/figure-a?token=${encodeURIComponent(token)}`,
  ), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'own');
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=300');
});

test('Alexa image links reject tampering and fall back to catalogue art', async () => {
  const token = await createImageToken(SECRET, CODE);
  const env = {
    ALEXA_IMAGE_SIGNING_KEY: SECRET,
    COLLECT: new MemoryKv([
      [`p:${CODE}`, '{}'],
      [`cat:${CODE}:set-a:figure-a`, new TextEncoder().encode('catalogue').buffer],
    ]),
  };
  const valid = await handleAlexaImage(new Request(
    `https://worker.example/alexa/image/set-a/figure-a?token=${encodeURIComponent(token)}`,
  ), env);
  assert.equal(await valid.text(), 'catalogue');

  const tampered = await handleAlexaImage(new Request(
    `https://worker.example/alexa/image/set-a/figure-a?token=${encodeURIComponent(token + 'x')}`,
  ), env);
  assert.equal(tampered.status, 401);
});
