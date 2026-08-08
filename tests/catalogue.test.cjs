/**
 * The catalogue namespace, exercised against the real worker module.
 *
 * The point being defended: a catalogue picture and his own photo of the SAME
 * figure must coexist. They share the key "setId/figureId" on the device and
 * differ only by namespace on the server, so a mistake here would have the seed
 * tool and a phone silently overwriting each other.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WORKER = pathToFileURL(path.join(__dirname, '..', 'worker', 'src', 'index.js')).href;
const CODE = 'pumpkin-hazel-nebula-squid';

/** Enough of Workers KV to run the handler: values, metadata, no expiry. */
function fakeKV() {
  const map = new Map();
  return {
    map,
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      return typeof hit.value === 'string' ? hit.value : null;
    },
    async getWithMetadata(key) {
      const hit = map.get(key);
      if (!hit) return { value: null, metadata: null };
      return { value: hit.value, metadata: hit.metadata || null };
    },
    async put(key, value, options = {}) {
      map.set(key, { value, metadata: options.metadata || null });
    },
    async delete(key) { map.delete(key); },
  };
}

function env(kv) {
  return {
    COLLECT: kv,
    ALLOWED_ORIGINS: '',
    RATE_LIMITER: { limit: async () => ({ success: true }) },
  };
}

const req = (method, url, { body, headers } = {}) => new Request(
  `https://example.invalid${url}`,
  { method, body, headers: { 'X-Family-Code': CODE, ...headers } }
);

const hashOf = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 16);

async function load() {
  const mod = await import(WORKER);
  return mod.default;
}

test('a catalogue picture and his own photo of one figure both survive', async () => {
  const worker = await load();
  const kv = fakeKV();
  const e = env(kv);

  const put = (kind, payload) => worker.fetch(
    req('PUT', `/v1/${kind}/sw-galaxy-peek-s1/grogu`, {
      body: payload, headers: { 'X-Photo-Hash': hashOf(payload) },
    }), e
  );

  assert.equal((await put('catalogue', 'CATALOGUE-PIXELS')).status, 200);
  assert.equal((await put('photo', 'HIS-OWN-PIXELS')).status, 200);

  const cat = await worker.fetch(req('GET', '/v1/catalogue/sw-galaxy-peek-s1/grogu'), e);
  const own = await worker.fetch(req('GET', '/v1/photo/sw-galaxy-peek-s1/grogu'), e);

  assert.equal(await cat.text(), 'CATALOGUE-PIXELS', 'the catalogue picture was overwritten');
  assert.equal(await own.text(), 'HIS-OWN-PIXELS', 'his own photo was overwritten');
});

test('the two indexes are reported separately', async () => {
  const worker = await load();
  const kv = fakeKV();
  const e = env(kv);

  await worker.fetch(req('PUT', '/v1/catalogue/sw-galaxy-peek-s1/grogu', {
    body: 'C', headers: { 'X-Photo-Hash': hashOf('C') },
  }), e);
  await worker.fetch(req('PUT', '/v1/photo/sw-galaxy-peek-s1/yoda', {
    body: 'P', headers: { 'X-Photo-Hash': hashOf('P') },
  }), e);

  const body = await (await worker.fetch(req('GET', '/v1/collection'), e)).json();

  assert.deepEqual(Object.keys(body.catalogue), ['sw-galaxy-peek-s1:grogu']);
  assert.deepEqual(Object.keys(body.photos), ['sw-galaxy-peek-s1:yoda']);
});

test('deleting his photo leaves the catalogue picture alone', async () => {
  const worker = await load();
  const kv = fakeKV();
  const e = env(kv);

  for (const kind of ['catalogue', 'photo']) {
    await worker.fetch(req('PUT', `/v1/${kind}/sw-galaxy-peek-s1/grogu`, {
      body: kind, headers: { 'X-Photo-Hash': hashOf(kind) },
    }), e);
  }

  await worker.fetch(req('DELETE', '/v1/photo/sw-galaxy-peek-s1/grogu'), e);

  const cat = await worker.fetch(req('GET', '/v1/catalogue/sw-galaxy-peek-s1/grogu'), e);
  assert.equal(cat.status, 200, 'deleting a photo took the catalogue picture with it');

  const body = await (await worker.fetch(req('GET', '/v1/collection'), e)).json();
  assert.deepEqual(Object.keys(body.photos), []);
  assert.deepEqual(Object.keys(body.catalogue), ['sw-galaxy-peek-s1:grogu']);
});

test('catalogue pictures need the family code like everything else', async () => {
  const worker = await load();
  const e = env(fakeKV());
  const anon = new Request('https://example.invalid/v1/catalogue/sw-galaxy-peek-s1/grogu');
  const response = await worker.fetch(anon, e);
  assert.equal(response.status, 401);
});

test('an unchanged picture does not spend a KV write', async () => {
  const worker = await load();
  const kv = fakeKV();
  const e = env(kv);

  const send = () => worker.fetch(req('PUT', '/v1/catalogue/sw-galaxy-peek-s1/grogu', {
    body: 'SAME', headers: { 'X-Photo-Hash': hashOf('SAME') },
  }), e);

  await send();
  const second = await (await send()).json();
  assert.equal(second.unchanged, true);
});

test('a figure id from outside our own sets is refused', async () => {
  const worker = await load();
  const e = env(fakeKV());
  const bad = await worker.fetch(
    req('PUT', '/v1/catalogue/sw-galaxy-peek-s1/..%2F..%2Fetc', {
      body: 'X', headers: { 'X-Photo-Hash': hashOf('X') },
    }), e
  );
  assert.equal(bad.status, 400);
});
