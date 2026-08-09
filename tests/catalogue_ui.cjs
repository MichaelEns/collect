#!/usr/bin/env node
/**
 * Catalogue pictures in a real browser: the database upgrade, and which
 * picture ends up on a card.
 *
 *   node tests/catalogue_ui.cjs "<edge path>"
 *
 * Adding the catalogue store took the database from v1 to v2. Every device in
 * the house is already on v1 with his photos in it, so the upgrade runs on real
 * data the first time each one loads the new code. Getting it wrong deletes
 * photographs of toys a child took himself, which are not reproducible.
 *
 * The main suite runs on a fresh profile and therefore creates v2 outright — it
 * never exercises the upgrade at all. This does: it writes a v1 database the
 * way the old code did, loads the app over the top, and checks the photo is
 * still there afterwards.
 *
 * It then checks the order the two kinds of picture are preferred in, which is
 * the whole point of the feature:
 *
 *     his own photo  >  catalogue picture  >  the letter tag
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BROWSER = process.argv[2];
const SITE_PORT = 8801;
const CDP_PORT = 9333;
const ROOT = path.join(__dirname, '..');
const PUBLISHED_AT = '/collect/';

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (!rel.startsWith(PUBLISHED_AT)) { res.writeHead(404); res.end(); return; }
    rel = rel.slice(PUBLISHED_AT.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.join(ROOT, rel);
    if (!full.startsWith(ROOT) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
      res.writeHead(404); res.end('no'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream' });
    res.end(fs.readFileSync(full));
  });
  return new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', () => resolve(server)));
}

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
    let body = ''; res.on('data', (d) => { body += d; });
    res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (detail !== undefined) console.log(`         ${detail}`);
  if (!ok) failures += 1;
}

/* Writes a v1 database exactly as the pre-catalogue code did. */
const WRITE_V1 = `new Promise((resolve) => {
  const req = indexedDB.open('collect', 1);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains('photos')) req.result.createObjectStore('photos');
  };
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('photos', 'readwrite');
    tx.objectStore('photos').put(new Blob(['HIS-OWN-PHOTO'], {type:'image/jpeg'}), 'sw-galaxy-peek-s1/grogu');
    tx.oncomplete = () => { const v = db.version; db.close(); resolve('wrote v' + v); };
    tx.onerror = () => resolve('write failed');
  };
  req.onerror = () => resolve('open failed');
})`;

const READ_BACK = `new Promise((resolve) => {
  const req = indexedDB.open('collect');
  req.onsuccess = async () => {
    const db = req.result;
    const stores = [...db.objectStoreNames];
    let photo = null;
    if (stores.includes('photos')) {
      photo = await new Promise((r) => {
        const g = db.transaction('photos','readonly').objectStore('photos').get('sw-galaxy-peek-s1/grogu');
        g.onsuccess = async () => r(g.result ? await g.result.text() : null);
        g.onerror = () => r(null);
      });
    }
    const out = { version: db.version, stores, photo };
    db.close();
    resolve(JSON.stringify(out));
  };
  req.onerror = () => resolve('{"error":"open failed"}');
})`;

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/catalogue_ui.cjs <browser>');
  const server = await serve();
  const base = `http://127.0.0.1:${SITE_PORT}${PUBLISHED_AT}`;
  const profile = path.join(os.tmpdir(), 'collect-migrate-' + Date.now());
  const proc = spawn(BROWSER, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*',
    '--disable-gpu', '--no-first-run', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: 'ignore' });

  let ws;
  try {
    let targets;
    for (let i = 0; i < 40; i += 1) {
      try { targets = await getJson('/json/list'); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    const target = (targets || []).find((t) => t.type === 'page' && !/^(edge|chrome|devtools):/i.test(t.url));
    if (!target) throw new Error('no page target');
    ws = await new Promise((resolve, reject) => {
      const s = new WebSocket(target.webSocketDebuggerUrl);
      s.onopen = () => resolve(s); s.onerror = () => reject(new Error('ws failed'));
    });

    let id = 1;
    const evalJs = async (expression) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
      return r.result.value;
    };

    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Page.enable', {});

    console.log('\n--- a device that already has photos ---');

    // Land on the origin WITHOUT loading the app, so the old database is the
    // only thing that has touched IndexedDB.
    await rpc(ws, id++, 'Page.navigate', { url: `${base}manifest.webmanifest` });
    await new Promise((r) => setTimeout(r, 800));
    const wrote = await evalJs(WRITE_V1);
    check('a v1 database with one of his photos exists', wrote === 'wrote v1', wrote);

    // Now the new code loads over the top of it — and into a SET, not the
    // picker. The database is opened lazily on first use, so a page showing no
    // figures never touches it and the upgrade would not run at all. This is
    // the path a child actually takes: open the app, tap a series.
    await rpc(ws, id++, 'Page.navigate', { url: `${base}#set=sw-galaxy-peek-s1` });
    await new Promise((r) => setTimeout(r, 3500));

    const after = JSON.parse(await evalJs(READ_BACK));
    console.log('\n--- after the new code has opened it ---');
    /*
     * Read the expected version out of app.js rather than hardcoding it. The
     * point of this check is that an OLD database is carried forward, not that
     * the schema has stopped changing — and pinning the number here meant that
     * adding the bin store failed a test whose real subject, his photo
     * surviving, had passed.
     */
    const wantVersion = Number(
      (fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
        .match(/indexedDB\.open\(DB_NAME,\s*(\d+)\)/) || [])[1]
    );
    check(`the database moved to v${wantVersion}`,
      wantVersion > 1 && after.version === wantVersion, `version=${after.version}`);
    check('the catalogue store now exists', after.stores.includes('catalogue'), JSON.stringify(after.stores));
    check('the photos store is still there', after.stores.includes('photos'));
    check('HIS PHOTO SURVIVED THE UPGRADE', after.photo === 'HIS-OWN-PHOTO', JSON.stringify(after.photo));

    const wired = await evalJs(`JSON.stringify({
      hasCatalogueApi: !!(window.__collect && window.__collect.catalogue),
      hasPhotoApi: !!(window.__collect && window.__collect.photos)
    })`);
    const w = JSON.parse(wired);
    console.log('\n--- the app is wired to both ---');
    check('the photo store is exposed', w.hasPhotoApi);
    check('the catalogue store is exposed', w.hasCatalogueApi);

    /*
     * Which picture ends up on a card.
     *
     * The two blobs are made different SIZES so the answer can be read off
     * naturalWidth. The blob URL is revoked as soon as it loads — deliberately,
     * so cards do not leak a URL each on every re-render — so the src cannot be
     * read back, but the decoded dimensions survive.
     */
    console.log('\n--- which picture wins ---');
    const PRECEDENCE = `(async () => {
      const png = (size) => new Promise((resolve) => {
        const c = document.createElement('canvas');
        c.width = size; c.height = size;
        c.getContext('2d').fillRect(0, 0, size, size);
        c.toBlob(resolve, 'image/png');
      });

      const cat = window.__collect.catalogue;
      const own = window.__collect.photos;

      // grogu: catalogue only. His photo from the migration step above is
      // removed first — that blob is text pretending to be a jpeg, so leaving
      // it would correctly win and then decode to nothing.
      await own.delete('sw-galaxy-peek-s1/grogu');
      await cat.put('sw-galaxy-peek-s1/grogu', await png(1));
      // yoda: both, so his own (4px) must beat the catalogue one (1px).
      await cat.put('sw-galaxy-peek-s1/yoda', await png(1));
      await own.put('sw-galaxy-peek-s1/yoda', await png(4));
      // jawa: neither.
      await cat.delete('sw-galaxy-peek-s1/jawa');
      await own.delete('sw-galaxy-peek-s1/jawa');

      window.__collect.route();
      await new Promise((r) => setTimeout(r, 1200));

      const read = (id) => {
        const el = document.querySelector('.fig-art[data-art="' + id + '"]');
        if (!el) return { found: false };
        const img = el.querySelector('img');
        return {
          found: true,
          hasImg: !!img,
          width: img ? img.naturalWidth : 0,
          text: (el.textContent || '').trim(),
        };
      };
      return JSON.stringify({
        grogu: read('grogu'), yoda: read('yoda'), jawa: read('jawa'),
      });
    })()`;

    const p = JSON.parse(await evalJs(PRECEDENCE));
    check('a figure with only a catalogue picture shows it',
      p.grogu.hasImg && p.grogu.width === 1, JSON.stringify(p.grogu));
    check('his own photo beats the catalogue picture',
      p.yoda.hasImg && p.yoda.width === 4, JSON.stringify(p.yoda));
    check('a figure with no picture at all keeps its letter tag',
      !p.jawa.hasImg && p.jawa.text.length > 0, JSON.stringify(p.jawa));

    console.log(failures ? `\n${failures} PROBLEM(S)\n` : '\nMIGRATION VERIFIED\n');
  } finally {
    if (ws) try { ws.close(); } catch { /* closing */ }
    try { proc.kill(); } catch { /* gone */ }
    server.close();
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
