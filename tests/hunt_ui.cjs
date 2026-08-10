#!/usr/bin/env node
/**
 * The hunt page in a real browser, after merging capsules by contents.
 *
 *   node tests/hunt_ui.cjs "<edge path>"
 *
 * The unit tests prove the grouping is sound. This proves the page actually
 * renders it: one card per capsule, every code on the card, and the count of
 * cards genuinely smaller than the count of codes.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const BROWSER = process.argv[2];
const SITE_PORT = 8802;
const CDP_PORT = 9334;
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

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/hunt_ui.cjs <browser>');
  const server = await serve();
  const base = `http://127.0.0.1:${SITE_PORT}${PUBLISHED_AT}`;
  const profile = path.join(os.tmpdir(), 'collect-hunt-' + Date.now());
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
    const problems = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.method === 'Runtime.exceptionThrown') {
        problems.push(msg.params.exceptionDetails.exception?.description || 'exception');
      }
      if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
        problems.push(msg.params.entry.text);
      }
    });
    const evalJs = async (expression) => {
      const r = await rpc(ws, id++, 'Runtime.evaluate', {
        expression, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'threw');
      return r.result.value;
    };

    await rpc(ws, id++, 'Runtime.enable', {});
    await rpc(ws, id++, 'Log.enable', {});
    await rpc(ws, id++, 'Page.enable', {});
    await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
    });

    // Series 1 is the worst case: 276 codes, 21 distinct capsules.
    await rpc(ws, id++, 'Page.navigate', { url: `${base}hunt.html#set=sw-galaxy-peek-s1` });
    await new Promise((r) => setTimeout(r, 3500));

    console.log('\n--- Series 1: 276 codes, 21 distinct capsules ---');

    const shape = JSON.parse(await evalJs(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.hunt-row')];
      const codes = [...document.querySelectorAll('.hunt-code')];
      const perCard = cards.map((c) => [...c.querySelectorAll('.hunt-code')].map((n) => n.textContent));
      const flat = perCard.flat();
      return {
        cards: cards.length,
        codeChips: codes.length,
        distinctCodes: new Set(flat).size,
        biggest: Math.max(...perCard.map((p) => p.length)),
        firstCardCodes: perCard[0] || [],
        contents: cards.map((c) => [...c.querySelectorAll('.hunt-fig-name')].map((n) => n.textContent).sort().join('|')),
      };
    })())`));

    check('the page rendered cards', shape.cards > 0, `${shape.cards} cards`);
    check('there are far fewer cards than codes',
      shape.cards < shape.codeChips / 3, `${shape.cards} cards from ${shape.codeChips} codes`);
    check('no code is shown twice',
      shape.distinctCodes === shape.codeChips, `${shape.distinctCodes} distinct of ${shape.codeChips}`);
    check('no two cards show the same contents',
      new Set(shape.contents).size === shape.contents.length,
      `${new Set(shape.contents).size} distinct of ${shape.contents.length}`);
    check('a capsule with many codes lists them all',
      shape.biggest > 5, `biggest card carries ${shape.biggest} codes`);
    console.log(`         first card: ${shape.firstCardCodes.join(' ')}`);

    /*
     * The whole point: "1" and "A001" hold the same four figures and used to
     * appear as two separate cards sixteen rows apart.
     */
    const together = JSON.parse(await evalJs(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.hunt-row')];
      for (const c of cards) {
        const codes = [...c.querySelectorAll('.hunt-code')].map((n) => n.textContent);
        if (codes.includes('1')) return { codes, hasA001: codes.includes('A001') };
      }
      return { codes: [], hasA001: false };
    })())`));
    check('code 1 and code A001 are now one card',
      together.hasA001, together.codes.join(' '));

    // The layout has to survive a dozen-plus chips on a phone.
    const layout = JSON.parse(await evalJs(`JSON.stringify((() => {
      const card = [...document.querySelectorAll('.hunt-row')]
        .map((c) => ({ c, n: c.querySelectorAll('.hunt-code').length }))
        .sort((a, b) => b.n - a.n)[0];
      const r = card.c.getBoundingClientRect();
      const chips = [...card.c.querySelectorAll('.hunt-code')];
      const overflow = chips.filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).length;
      return { codes: card.n, width: Math.round(r.width), viewport: window.innerWidth, overflow };
    })())`));
    check('the busiest card stays inside the phone screen',
      layout.width <= layout.viewport && layout.overflow === 0,
      `${layout.codes} codes, card ${layout.width}px in a ${layout.viewport}px viewport, ${layout.overflow} chips overflowing`);

    check('no console errors', problems.length === 0, problems.slice(0, 3).join(' | ') || 'none');

    // And the all-series view, which is what opens by default.
    await rpc(ws, id++, 'Page.navigate', { url: `${base}hunt.html` });
    await new Promise((r) => setTimeout(r, 3500));
    console.log('\n--- every series at once ---');
    const all = JSON.parse(await evalJs(`JSON.stringify((() => {
      const cards = [...document.querySelectorAll('.hunt-row')];
      return {
        cards: cards.length,
        contents: cards.map((c) => c.closest('.hunt-row').querySelector('.hunt-series-name').textContent
          + '::' + [...c.querySelectorAll('.hunt-fig-name')].map((n) => n.textContent).sort().join('|')),
      };
    })())`));
    check('cards are still unique across series',
      new Set(all.contents).size === all.contents.length,
      `${new Set(all.contents).size} distinct of ${all.contents.length}`);

    console.log(failures ? `\n${failures} PROBLEM(S)\n` : '\nHUNT MERGE VERIFIED\n');
  } finally {
    if (ws) try { ws.close(); } catch { /* closing */ }
    try { proc.kill(); } catch { /* gone */ }
    server.close();
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
