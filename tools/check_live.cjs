/*
 * Checks the live sync worker over the real internet.
 *
 * The two-device test proves the logic against a local stand-in for KV. This
 * proves the deployed thing: real Workers KV, real rate limiter binding, real
 * CORS. They fail in different ways, so both are worth having.
 *
 *   node tools/check_live.cjs [https://...workers.dev]
 */
'use strict';

const BASE = process.argv[2] || 'https://collect-sync.michaelens.workers.dev';

let fails = 0;
const check = (what, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `\n         ${detail}` : ''}`);
  if (!ok) fails += 1;
};

const call = async (path, { method = 'GET', code, origin, body, headers = {}, raw } = {}) => {
  const response = await fetch(BASE + path, {
    method,
    headers: {
      ...(code ? { 'X-Family-Code': code } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body,
  });
  if (raw) return response;
  let json = null;
  try { json = await response.json(); } catch { /* not json */ }
  return { status: response.status, json, headers: response.headers };
};

const at = (over = {}) => ({ have: true, dupes: 0, codes: [], updatedAt: Date.now(), ...over });

async function main() {
  console.log(`\nchecking ${BASE}\n`);

  const health = await call('/health');
  check('the worker is up', health.status === 200 && health.json.ok === true,
    JSON.stringify(health.json));

  const noCode = await call('/v1/collection');
  check('a request with no family code is refused', noCode.status === 401, `got ${noCode.status}`);

  const bad = await call('/v1/collection', { code: 'not-a-real-family-code' });
  check('a made-up code is refused', bad.status === 401, `got ${bad.status}`);

  const made = await call('/v1/new', { method: 'POST' });
  const code = made.json && made.json.code;
  check('a new family code is issued',
    made.status === 200 && /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/.test(code || ''), code);

  const second = await call('/v1/new', { method: 'POST' });
  check('and two codes are not the same', second.json.code !== code, second.json.code);

  const push = await call('/v1/collection', {
    method: 'POST',
    code,
    body: JSON.stringify({ progress: { s2: { luke: at({ codes: ['a 001'] }) } } }),
  });
  check('a push is stored, and the code is tidied on the way in',
    push.status === 200 && push.json.progress.s2.luke.have === true
      && push.json.progress.s2.luke.codes[0] === 'A001',
    JSON.stringify(push.json.progress));

  const empty = await call('/v1/collection', {
    method: 'POST', code, body: JSON.stringify({ progress: {} }),
  });
  check('an empty push does not wipe the collection',
    empty.json.progress.s2 && empty.json.progress.s2.luke.have === true,
    JSON.stringify(empty.json.progress));

  const other = await call('/v1/collection', {
    method: 'POST', code, body: JSON.stringify({ progress: { s2: { rey: at() } } }),
  });
  check('a second device adds without removing',
    Object.keys(other.json.progress.s2).sort().join(',') === 'luke,rey',
    Object.keys(other.json.progress.s2).join(','));

  const stale = await call('/v1/collection', {
    method: 'POST',
    code,
    body: JSON.stringify({ progress: { s2: { luke: at({ have: false, updatedAt: 1 }) } } }),
  });
  check('a stale edit does not undo a newer one',
    stale.json.progress.s2.luke.have === true, JSON.stringify(stale.json.progress.s2.luke));

  const junk = await call('/v1/collection', {
    method: 'POST', code, body: 'not json at all',
  });
  check('rubbish is rejected rather than stored', junk.status === 400, `got ${junk.status}`);

  const foreign = await call('/v1/collection', { code, origin: 'https://evil.example.com' });
  check('a browser on another site cannot read the collection',
    foreign.status === 403, `got ${foreign.status}`);

  const ours = await call('/v1/collection', { code, origin: 'https://michaelens.github.io' });
  check('but the app itself can',
    ours.status === 200
      && ours.headers.get('access-control-allow-origin') === 'https://michaelens.github.io',
    `${ours.status} / ${ours.headers.get('access-control-allow-origin')}`);

  const preflight = await call('/v1/collection', {
    method: 'OPTIONS', origin: 'https://michaelens.github.io',
  });
  check('the browser preflight passes',
    preflight.status === 204
      && (preflight.headers.get('access-control-allow-headers') || '').includes('X-Family-Code'),
    `${preflight.status} / ${preflight.headers.get('access-control-allow-headers')}`);

  // Photos.
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 3, 4, 0xff, 0xd9]);
  const put = await fetch(`${BASE}/v1/photo/s2/luke`, {
    method: 'PUT',
    headers: { 'X-Family-Code': code, 'X-Photo-Hash': 'abc12345' },
    body: jpeg,
  });
  check('a photo can be stored', put.status === 200, `got ${put.status}`);

  const again = await fetch(`${BASE}/v1/photo/s2/luke`, {
    method: 'PUT',
    headers: { 'X-Family-Code': code, 'X-Photo-Hash': 'abc12345' },
    body: jpeg,
  });
  const againBody = await again.json();
  check('an unchanged photo is not written twice',
    againBody.unchanged === true, JSON.stringify(againBody));

  const got = await fetch(`${BASE}/v1/photo/s2/luke`, { headers: { 'X-Family-Code': code } });
  const bytes = new Uint8Array(await got.arrayBuffer());
  check('and comes back byte for byte',
    bytes.length === jpeg.length && bytes.every((b, i) => b === jpeg[i]),
    `${bytes.length} bytes`);

  const listed = await call('/v1/collection', { code });
  check('the photo is listed with its hash',
    listed.json.photos && listed.json.photos['s2:luke'] === 'abc12345',
    JSON.stringify(listed.json.photos));

  const noHash = await fetch(`${BASE}/v1/photo/s2/luke`, {
    method: 'PUT', headers: { 'X-Family-Code': code }, body: jpeg,
  });
  check('a photo with no hash is refused', noHash.status === 400, `got ${noHash.status}`);

  const nastyId = await fetch(`${BASE}/v1/photo/..%2F..%2Fetc/luke`, {
    method: 'PUT',
    headers: { 'X-Family-Code': code, 'X-Photo-Hash': 'abc12345' },
    body: jpeg,
  });
  check('a path-traversal id is refused',
    nastyId.status === 400 || nastyId.status === 404, `got ${nastyId.status}`);

  const removed = await fetch(`${BASE}/v1/photo/s2/luke`, {
    method: 'DELETE', headers: { 'X-Family-Code': code },
  });
  check('a photo can be removed', removed.status === 200, `got ${removed.status}`);

  // Another family's code must not see any of that.
  const stranger = await call('/v1/new', { method: 'POST' });
  const theirs = await call('/v1/collection', { code: stranger.json.code });
  check('another family sees an empty collection, not ours',
    Object.keys(theirs.json.progress || {}).length === 0
      && Object.keys(theirs.json.photos || {}).length === 0,
    JSON.stringify(theirs.json));

  console.log(fails === 0 ? '\nLIVE SYNC VERIFIED \u2705' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.stack); process.exit(1); });
