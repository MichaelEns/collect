/*
 * Two devices, one collection.
 *
 * Drives two real browser profiles against a real HTTP server running the real
 * worker code, and checks they converge without either losing its own work.
 * The worker module is imported rather than reimplemented, so this exercises
 * the merge that actually ships.
 *
 *   node tests/sync.cjs "<path to msedge.exe>"
 *
 * With --live it drives the PUBLISHED site against the DEPLOYED worker
 * instead, which is the only way to catch things the local double gets wrong
 * (KV's eventual consistency being the one that already bit):
 *
 *   node tests/sync.cjs "<path to msedge.exe>" --live
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const LIVE = process.argv.includes('--live');
const LIVE_URL = 'https://michaelens.github.io/collect/';
const SITE_PORT = 8797;
const SYNC_PORT = 8798;
const ROOT = path.dirname(__dirname);
const PUB = '/collect/';

let fails = 0;
const check = (what, ok, detail) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `\n         ${detail}` : ''}`);
  if (!ok) fails += 1;
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/* ------------------------------------------------------- the site, as served */

function serveSite() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (!rel.startsWith(PUB)) { res.writeHead(404); res.end(); return; }
    rel = rel.slice(PUB.length);
    let file = path.join(ROOT, rel);
    if (rel === '' || rel.endsWith('/')) file = path.join(ROOT, rel, 'index.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    let body = fs.readFileSync(file);
    // Point the app at the test sync server instead of the live worker.
    if (file.endsWith('sync.js')) {
      body = Buffer.from(String(body).replace(
        /const ENDPOINT = '[^']+'/, `const ENDPOINT = 'http://127.0.0.1:${SYNC_PORT}'`
      ));
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
  return new Promise((r) => server.listen(SITE_PORT, '127.0.0.1', () => r(server)));
}

/* ------------------------- the worker, running its real code over plain http */

async function serveSync() {
  const { default: worker } = await import(
    'file://' + path.join(ROOT, 'worker', 'src', 'index.js').replace(/\\/g, '/')
  );

  // A stand-in for Workers KV, with the same surface the worker uses.
  const kv = new Map();
  const meta = new Map();
  const listVisible = new Set();

  const COLLECT = {
    async get(key, opts) {
      if (!kv.has(key)) return null;
      const value = kv.get(key);
      if (opts && opts.type === 'arrayBuffer') return value;
      return typeof value === 'string' ? value : Buffer.from(value).toString();
    },
    async getWithMetadata(key, opts) {
      if (!kv.has(key)) return { value: null, metadata: null };
      return { value: await COLLECT.get(key, opts), metadata: meta.get(key) || null };
    },
    async put(key, value, options) {
      kv.set(key, value);
      if (options && options.metadata) meta.set(key, options.metadata);
    },
    async delete(key) { kv.delete(key); meta.delete(key); listVisible.delete(key); },

    /*
     * Deliberately lagging, because the real one does.
     *
     * KV list() is eventually consistent: measured against the deployed
     * worker, a freshly written key took about twenty seconds to appear. An
     * earlier version of this double returned writes immediately, which made
     * a genuine photo-sync bug pass here and fail only in production. A key is
     * now invisible to list() until something else has been written since.
     */
    async list({ prefix }) {
      const keys = [...kv.keys()].filter((k) => k.startsWith(prefix) && listVisible.has(k));
      for (const k of kv.keys()) listVisible.add(k);
      return {
        keys: keys.map((name) => ({ name, metadata: meta.get(name) || null })),
        list_complete: true,
      };
    },
  };

  const env = {
    COLLECT,
    ALLOWED_ORIGINS: `http://127.0.0.1:${SITE_PORT}`,
    RATE_LIMITER: { async limit() { return { success: true }; } },
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const request = new Request(`http://127.0.0.1:${SYNC_PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    });
    const response = await worker.fetch(request, env);
    const out = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(out);
  });
  await new Promise((r) => server.listen(SYNC_PORT, '127.0.0.1', r));
  return { server, kv };
}

/* ------------------------------------------------------------ one "device" */

let nextPort = 9300;

async function openDevice(label) {
  const cdp = nextPort++;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `dev-${label}-`));
  const proc = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${cdp}`, '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });

  const list = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: cdp, path: '/json/list' }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });

  let targets;
  for (let i = 0; i < 60; i += 1) {
    try { targets = await list(); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  // Edge opens its own pages; attaching to one of those tests nothing at all.
  const pages = targets.filter((t) => t.type === 'page');
  const target = pages.find((t) => t.url === 'about:blank')
    || pages.find((t) => !/^(edge|chrome|devtools):/i.test(t.url)) || pages[0];

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('ws')); });

  let id = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const mine = ++id;
    const onMessage = (event) => {
      const m = JSON.parse(event.data);
      if (m.id === mine) { ws.removeEventListener('message', onMessage); resolve(m.result); }
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id: mine, method, params }));
  });

  const evalJs = async (expression) => {
    const r = await rpc('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    return r && r.result ? r.result.value : undefined;
  };

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Page.navigate', {
    url: LIVE ? LIVE_URL : `http://127.0.0.1:${SITE_PORT}${PUB}`,
  });
  await new Promise((r) => setTimeout(r, LIVE ? 4000 : 2200));

  return {
    label,
    evalJs,
    async open(setId) {
      await evalJs(`location.hash = '#set=${setId}'; 1`);
      await new Promise((r) => setTimeout(r, 900));
    },
    async tick(figureId, have = true) {
      await evalJs(`window.__collect.setHave('${figureId}', ${have}); 1`);
      await new Promise((r) => setTimeout(r, 120));
    },
    async syncNow() {
      await evalJs('window.CollectSync.syncNow()');
      await new Promise((r) => setTimeout(r, LIVE ? 1500 : 700));
    },
    async offline() {
      await rpc('Network.enable', {});
      await rpc('Network.emulateNetworkConditions', {
        offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
      });
    },
    async found() {
      return JSON.parse(await evalJs(
        'JSON.stringify(window.__collect.state.set.figures.filter('
        + 'f => (window.__collect.state.progress[f.id]||{}).have).map(f => f.id).sort())'
      ));
    },
    close() {
      try { ws.close(); } catch { /* gone */ }
      try { process.kill(proc.pid); } catch { /* gone */ }
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ } }, 500);
    },
  };
}

/* -------------------------------------------------------------------- main */

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/sync.cjs <browser> [--live]');
  console.log(LIVE
    ? `\nDRIVING THE PUBLISHED SITE at ${LIVE_URL} against the deployed worker`
    : '\nDriving a local copy against the worker code in-process');

  // In live mode there is nothing to serve and nothing to fake: the real site
  // and the real worker are already out there.
  const site = LIVE ? null : await serveSite();
  const local = LIVE ? null : await serveSync();
  const sync = local ? local.server : null;
  const kv = local ? local.kv : null;

  /*
   * Figure ids come from the set file, not from memory. A first draft of this
   * test ticked "yoda" and "jawa" — Series 1 figures that do not exist in
   * Series 2 — and reported them as data loss. The test was wrong, but it took
   * a while to prove that, so now a bad id fails loudly and immediately.
   */
  const SET = 'sw-galaxy-peek-s2';
  const roster = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'sets', `${SET}.json`), 'utf8')
  ).figures.map((f) => f.id);
  const fig = (id) => {
    if (!roster.includes(id)) throw new Error(`"${id}" is not in ${SET}; ids: ${roster.join(', ')}`);
    return id;
  };
  const [ONE, TWO, THREE, FOUR, FIVE] = ['luke-skywalker', 'rey', 'omega', 'finn', 'darth-maul'].map(fig);

  let a; let b;
  try {
    console.log('\n--- turning sharing on, on the first device ---');
    a = await openDevice('a');
    await a.open(SET);
    const code = await a.evalJs('window.CollectSync.create()');
    check('a family code is issued', /^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/.test(code || ''), code);
    check('and it is remembered on the device',
      (await a.evalJs('window.CollectSync.getCode()')) === code);

    await a.tick(ONE);
    await a.tick(TWO);
    await a.syncNow();
    if (kv) {
      const stored = JSON.parse(kv.get(`p:${code}`) || '{}')[SET] || {};
      check('what he ticks reaches the server',
        Object.keys(stored).length === 2, Object.keys(stored).join(','));
    } else {
      // Live: ask the worker what it holds rather than peeking into storage.
      const seen = await a.evalJs(`(async () => {
        const r = await fetch(window.CollectSync.endpoint + '/v1/collection',
          { headers: { 'X-Family-Code': window.CollectSync.getCode() } });
        const j = await r.json();
        return JSON.stringify(Object.keys((j.progress || {})['${SET}'] || {}).sort());
      })()`);
      check('what he ticks reaches the server',
        JSON.parse(seen || '[]').length === 2, seen);
    }

    console.log('\n--- a second device joins with the same code ---');
    b = await openDevice('b');
    const joined = await b.evalJs(`window.CollectSync.join(${JSON.stringify(code)})`);
    check('the code is accepted', joined === true, String(joined));
    await b.open(SET);
    await new Promise((r) => setTimeout(r, 400));
    const onB = await b.found();
    check('the collection arrives on the new device',
      JSON.stringify(onB) === JSON.stringify([ONE, TWO].sort()), JSON.stringify(onB));

    console.log('\n--- both devices work at once ---');
    await a.tick(THREE);
    await b.tick(FOUR);
    await b.syncNow();
    await a.syncNow();
    await b.syncNow();
    const finalA = await a.found();
    const finalB = await b.found();
    const both = [ONE, TWO, THREE, FOUR].sort();
    check('neither device loses its own work',
      JSON.stringify(finalA) === JSON.stringify(both), JSON.stringify(finalA));
    check('and they end up agreeing',
      JSON.stringify(finalA) === JSON.stringify(finalB), JSON.stringify(finalB));

    console.log('\n--- un-ticking travels too ---');
    await b.tick(TWO, false);
    await b.syncNow();
    await a.syncNow();
    const afterUntick = await a.found();
    check('taking one off the list is not undone by the other device',
      !afterUntick.includes(TWO), JSON.stringify(afterUntick));

    console.log('\n--- a reinstalled device cannot wipe the collection ---');
    // The disaster case: same code, empty storage, pushes before it pulls.
    await b.evalJs(`window.localStorage.removeItem('collect.progress.${SET}'); 1`);
    await b.evalJs('window.__collect.route()');
    await new Promise((r) => setTimeout(r, 500));
    await b.syncNow();
    await new Promise((r) => setTimeout(r, 400));
    await a.syncNow();
    const survived = await a.found();
    check('the other device still has everything',
      JSON.stringify(survived) === JSON.stringify([ONE, THREE, FOUR].sort()),
      JSON.stringify(survived));
    const backOnB = await b.found();
    check('and the emptied device gets it all back',
      JSON.stringify(backOnB) === JSON.stringify([ONE, THREE, FOUR].sort()),
      JSON.stringify(backOnB));

    console.log('\n--- a photo he takes appears on the other device ---');
    /*
     * Photos are the heavy half of sync and the easiest to get quietly wrong,
     * so this puts a real blob in IndexedDB on one device and reads the bytes
     * back on the other.
     */
    const madePhoto = await a.evalJs(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 8; canvas.height = 8;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#c81e1e'; ctx.fillRect(0, 0, 8, 8);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
      await window.__collect.photos.put('${SET}/${ONE}', blob);
      return blob.size;
    })()`);
    check('a photo is stored on the first device', madePhoto > 0, `${madePhoto} bytes`);

    await a.syncNow();
    await new Promise((r) => setTimeout(r, 900));
    if (kv) {
      const uploaded = [...kv.keys()].filter((k) => k.startsWith(`ph:${code}:`));
      check('and it reaches the server',
        uploaded.length === 1 && uploaded[0].endsWith(`${SET}:${ONE}`), uploaded.join(','));
    } else {
      const listed = await a.evalJs(`(async () => {
        const r = await fetch(window.CollectSync.endpoint + '/v1/collection',
          { headers: { 'X-Family-Code': window.CollectSync.getCode() } });
        return JSON.stringify((await r.json()).photos || {});
      })()`);
      check('and it reaches the server',
        JSON.parse(listed || '{}')[`${SET}:${ONE}`] !== undefined, listed);
    }

    await b.syncNow();
    await new Promise((r) => setTimeout(r, 1200));
    const onOther = await b.evalJs(`(async () => {
      const blob = await window.__collect.photos.get('${SET}/${ONE}');
      return blob ? blob.size : 0;
    })()`);
    check('and arrives on the other device, byte for byte',
      onOther === madePhoto, `${onOther} bytes there vs ${madePhoto} here`);

    const reuploaded = await a.evalJs('(async () => {'
      + 'await window.CollectSync.syncNow();'
      + "return JSON.stringify(Object.keys(JSON.parse(localStorage.getItem('collect.photoHashes')||'{}')));"
      + '})()');
    check('an unchanged photo is remembered rather than sent again',
      JSON.parse(reuploaded || '[]').includes(`${SET}/${ONE}`), reuploaded);

    console.log('\n--- deleting a photo does not bring it back ---');
    /*
     * The resurrection trap: if the server advertised photos from an
     * eventually-consistent list, a photo deleted on one device would still be
     * advertised for a while, and the other device would helpfully download it
     * again. The index the worker keeps is written immediately, so a delete
     * takes effect at once.
     */
    await b.evalJs(`(async () => {
      await window.__collect.photos.delete('${SET}/${ONE}');
      await fetch(window.CollectSync.endpoint + '/v1/photo/${SET}/${ONE}', {
        method: 'DELETE', headers: { 'X-Family-Code': window.CollectSync.getCode() },
      });
      return 1;
    })()`);
    await b.syncNow();
    await new Promise((r) => setTimeout(r, 800));
    const backAgain = await b.evalJs(`(async () => {
      const blob = await window.__collect.photos.get('${SET}/${ONE}');
      return blob ? blob.size : 0;
    })()`);
    check('a deleted photo stays deleted', backAgain === 0, `${backAgain} bytes came back`);

    console.log('\n--- a wrong code is refused ---');
    const bad = await b.evalJs("window.CollectSync.join('not-a-real-family-code')");
    check('a made-up code does not silently start an empty collection',
      bad === false, String(bad));
    check('and the working code is still in place',
      (await b.evalJs('window.CollectSync.getCode()')) === code);

    console.log('\n--- offline is not an error the child has to care about ---');
    if (sync) {
      await new Promise((r) => { sync.closeAllConnections(); sync.close(r); });
    } else {
      // Live: cut the browser off rather than the deployed worker.
      await a.offline();
    }
    await a.tick(FIVE);
    await a.syncNow();
    const offline = JSON.parse(await a.evalJs('JSON.stringify(window.CollectSync.status())'));
    check('sync reports being offline rather than breaking',
      ['offline', 'error'].includes(offline.status), offline.status);
    const stillThere = await a.found();
    check('and the tick is still on the device',
      stillThere.includes(FIVE), JSON.stringify(stillThere));
  } finally {
    if (a) a.close();
    if (b) b.close();
    if (site) site.close();
    if (sync) { try { sync.close(); } catch { /* already closed */ } }
  }

  console.log(fails === 0 ? '\nSYNC VERIFIED \u2705' : `\n${fails} CHECK(S) FAILED`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.stack); process.exit(1); });
