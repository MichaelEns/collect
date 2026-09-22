import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker/src/index.js';
import { makeCode } from '../worker/src/code.js';

class MemoryKv {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  async get(key, type) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    return type === 'json' ? JSON.parse(value) : value;
  }

  async put(key, value) {
    this.values.set(key, value);
  }
}

function environment(entries = []) {
  return {
    COLLECT: new MemoryKv(entries),
    RATE_LIMITER: { limit: async () => ({ success: true }) },
    ALLOWED_ORIGINS: 'https://michaelens.github.io',
  };
}

test('a well-formed but unknown family code is rejected', async () => {
  const code = makeCode();
  const request = new Request('https://worker.example/v1/collection', {
    headers: { 'X-Family-Code': code },
  });
  const response = await worker.fetch(request, environment());
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'that is not a family code' });
});

test('an existing empty collection remains a valid family code', async () => {
  const code = makeCode();
  const request = new Request('https://worker.example/v1/collection', {
    headers: { 'X-Family-Code': code },
  });
  const response = await worker.fetch(
    request, environment([[`p:${code}`, JSON.stringify({})]]));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).progress, {});
});
