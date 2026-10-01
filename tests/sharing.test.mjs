import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../worker/src/index.js';

const OWNER_CODE = 'foxglove-lizard-donut-donut';

class MemoryKv {
  constructor(entries = []) {
    this.values = new Map(entries);
  }

  async get(key, options) {
    if (!this.values.has(key)) return null;
    const value = this.values.get(key);
    if (options && options.type === 'arrayBuffer') {
      return new TextEncoder().encode(String(value)).buffer;
    }
    return value;
  }

  async getWithMetadata(key, options) {
    return {
      value: await this.get(key, options),
      metadata: null,
    };
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

function environment() {
  return {
    COLLECT: new MemoryKv([
      [`p:${OWNER_CODE}`, '{}'],
      [`info:${OWNER_CODE}`, JSON.stringify({ name: "Joe's Collection" })],
    ]),
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };
}

function request(path, {
  method = 'GET',
  code = OWNER_CODE,
  body,
  headers = {},
} = {}) {
  return new Request(`https://worker.example${path}`, {
    method,
    headers: {
      ...(code ? { 'X-Family-Code': code } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined
      ? undefined
      : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function createShare(env, role) {
  const response = await worker.fetch(request('/v1/shares', {
    method: 'POST',
    body: { role },
  }), env);
  assert.equal(response.status, 201);
  return response.json();
}

test('legacy owner codes remain valid and get a default name', async () => {
  const env = {
    COLLECT: new MemoryKv([[`p:${OWNER_CODE}`, '{}']]),
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };
  const response = await worker.fetch(request('/v1/access'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    name: 'My Collection',
    role: 'owner',
  });
});

test('a contributor share can merge progress but cannot replace catalogue art', async () => {
  const env = environment();
  const share = await createShare(env, 'contributor');

  const access = await worker.fetch(request('/v1/access', {
    code: share.code,
  }), env);
  assert.deepEqual(await access.json(), {
    name: "Joe's Collection",
    role: 'contributor',
  });

  const progress = {
    'sw-galaxy-peek-s2': {
      amidala: { have: true, updatedAt: 100 },
    },
  };
  const update = await worker.fetch(request('/v1/collection', {
    method: 'POST',
    code: share.code,
    body: { progress },
  }), env);
  assert.equal(update.status, 200);
  assert.equal(
    (await update.json()).progress['sw-galaxy-peek-s2'].amidala.have,
    true,
  );

  const catalogue = await worker.fetch(request(
    '/v1/catalogue/sw-galaxy-peek-s2/amidala',
    {
      method: 'PUT',
      code: share.code,
      body: 'pixels',
      headers: { 'X-Photo-Hash': 'abcdef12' },
    },
  ), env);
  assert.equal(catalogue.status, 403);
  assert.deepEqual(await catalogue.json(), {
    error: 'owner access required',
  });
});

test('a viewer share can read but cannot change a collection', async () => {
  const env = environment();
  const share = await createShare(env, 'viewer');

  const read = await worker.fetch(request('/v1/collection', {
    code: share.code,
  }), env);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).role, 'viewer');

  const write = await worker.fetch(request('/v1/collection', {
    method: 'POST',
    code: share.code,
    body: { progress: {} },
  }), env);
  assert.equal(write.status, 403);
  assert.deepEqual(await write.json(), {
    error: 'contributor access required',
  });
});

test('only the owner can create, list, rename, and revoke share codes', async () => {
  const env = environment();
  const share = await createShare(env, 'viewer');

  const forbiddenCreate = await worker.fetch(request('/v1/shares', {
    method: 'POST',
    code: share.code,
    body: { role: 'viewer' },
  }), env);
  assert.equal(forbiddenCreate.status, 403);

  const forbiddenRename = await worker.fetch(request('/v1/collection-info', {
    method: 'PUT',
    code: share.code,
    body: { name: 'Not allowed' },
  }), env);
  assert.equal(forbiddenRename.status, 403);

  const renamed = await worker.fetch(request('/v1/collection-info', {
    method: 'PUT',
    body: { name: "Joe and Grandma's Collection" },
  }), env);
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).name, "Joe and Grandma's Collection");

  const listed = await worker.fetch(request('/v1/shares'), env);
  assert.deepEqual((await listed.json()).shares, [{
    code: share.code,
    role: 'viewer',
    createdAt: share.createdAt,
  }]);

  const removed = await worker.fetch(request(
    `/v1/shares/${encodeURIComponent(share.code)}`,
    { method: 'DELETE' },
  ), env);
  assert.equal(removed.status, 200);

  const revoked = await worker.fetch(request('/v1/access', {
    code: share.code,
  }), env);
  assert.equal(revoked.status, 401);
});
