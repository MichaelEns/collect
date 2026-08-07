/*
 * Captures one screenshot per screen, for the README and for eyeballing.
 *
 *   node tools/screenshots.cjs        (with EDGE set to msedge.exe)
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CDP = 9267;
const PORT = 8796;
const PUB = '/collect/';
const ROOT = path.join(__dirname, '..');

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const srv = http.createServer((q, s) => {
  const p = decodeURIComponent(q.url.split('?')[0]);
  if (!p.startsWith(PUB)) { s.writeHead(404).end(); return; }
  // From the resolved FILE, not the URL: "/collect/" has no extension, so
  // deriving it from the path serves index.html as octet-stream and the
  // browser downloads it instead of rendering it.
  const file = path.join(ROOT, p.slice(PUB.length) || 'index.html');
  fs.readFile(file, (e, b) => {
    if (e) { s.writeHead(404).end(); return; }
    s.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    s.end(b);
  });
});

const gj = (p) => new Promise((r, j) => http.get({ host: '127.0.0.1', port: CDP, path: p }, (x) => {
  let b = ''; x.on('data', (c) => { b += c; });
  x.on('end', () => { try { r(JSON.parse(b)); } catch (e) { j(e); } });
}).on('error', j));

function rpc(ws, id, m, p) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + m)), 45000);
    const h = (ev) => {
      const g = JSON.parse(ev.data);
      if (g.id !== id) return;
      clearTimeout(t); ws.removeEventListener('message', h);
      if (g.error) rej(new Error(m)); else res(g.result);
    };
    ws.addEventListener('message', h);
    ws.send(JSON.stringify({ id, method: m, params: p }));
  });
}

(async () => {
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + PORT + PUB;
  const prof = path.join(os.tmpdir(), 'shot' + Date.now());
  const proc = spawn(process.env.EDGE, [
    '--headless=new', '--remote-debugging-port=' + CDP, '--remote-allow-origins=*',
    '--disable-gpu', '--no-first-run', '--user-data-dir=' + prof, 'about:blank',
  ], { stdio: 'ignore' });

  let tg;
  for (let i = 0; i < 40; i += 1) {
    try { tg = await gj('/json/list'); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  const pages = tg.filter((t) => t.type === 'page');
  const target = pages.find((t) => t.url === 'about:blank')
    || pages.find((t) => !/^(edge|chrome|devtools):/i.test(t.url)) || pages[0];
  const ws = await new Promise((r, j) => {
    const s = new WebSocket(target.webSocketDebuggerUrl);
    s.onopen = () => r(s); s.onerror = () => j(new Error('ws'));
  });

  let id = 1;
  await rpc(ws, id++, 'Page.enable', {});
  await rpc(ws, id++, 'Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true,
  });

  const shoot = async (name) => {
    const s = await rpc(ws, id++, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(name, Buffer.from(s.data, 'base64'));
    console.log('wrote', name);
  };
  const run = (expression) => rpc(ws, id++, 'Runtime.evaluate', { expression });

  await rpc(ws, id++, 'Page.navigate', { url: base });
  await new Promise((r) => setTimeout(r, 2500));
  await shoot('c-picker.png');

  await rpc(ws, id++, 'Page.navigate', { url: base + '#set=sw-galaxy-peek-s2' });
  await new Promise((r) => setTimeout(r, 2500));

  // A partly-finished collection, so the grid shows both states at once.
  await run("['queen-amidala','wrecker','luke-skywalker','rey','darth-maul','omega','finn']"
    + ".forEach(function (f) { window.__collect.setHave(f, true); });");
  await new Promise((r) => setTimeout(r, 1200));
  await shoot('c-grid.png');

  await run("document.querySelectorAll('.fig')[20].click();");
  await new Promise((r) => setTimeout(r, 900));
  await shoot('c-sheet.png');

  // The capsule finder, mid-answer: this is the screen that gets used in a shop.
  await run("document.getElementById('sheet-close').click();");
  await new Promise((r) => setTimeout(r, 500));
  await run("(function () {"
    + " var el = document.getElementById('code-input');"
    + " el.value = 'C004';"
    + " el.dispatchEvent(new Event('input', { bubbles: true }));"
    + " window.scrollTo(0, 0);"
    + "})();");
  await new Promise((r) => setTimeout(r, 800));
  await shoot('c-finder.png');

  // Series 5: the newest set, and the one carrying the most caveats — a
  // different capsule shape, and a rarity list Just Play has not published.
  await rpc(ws, id++, 'Page.navigate', { url: base + '#set=sw-galaxy-peek-s5' });
  await new Promise((r) => setTimeout(r, 2500));
  await shoot('c-series5.png');

  ws.close();
  try { process.kill(proc.pid); } catch { /* gone */ }
  srv.close();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
