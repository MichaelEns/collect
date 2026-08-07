/*
 * Does the tracker actually work?
 *
 * Drives the real page: picks a set, marks figures, records a code, reloads to
 * prove the progress survived, then kills the server and reopens it offline —
 * which is the state a phone is in halfway down a shop aisle.
 *
 *   node tests\collect.cjs "<edge path>"
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BROWSER = process.argv[2];
const SITE_PORT = 8795;
const CDP_PORT = 9266;
const PUBLISHED_AT = '/collect/';
const ROOT = path.join(__dirname, '..');

let fails = 0;
function check(name, cond, extra) {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '\n         ' + extra : ''));
  if (!cond) fails += 1;
}

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    if (!p.startsWith(PUBLISHED_AT)) { res.writeHead(404).end('outside the published path'); return; }
    const rel = p.slice(PUBLISHED_AT.length) || 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      // From the resolved FILE, not the URL: "/collect/" has no extension, so
      // deriving it from the path serves index.html as octet-stream and the
      // browser downloads it instead of rendering it.
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    });
  });
  return new Promise((r) => server.listen(SITE_PORT, '127.0.0.1', () => r(server)));
}

const getJson = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: p }, (res) => {
    let b = ''; res.on('data', (c) => { b += c; });
    res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
  }).on('error', reject);
});

/*
 * Edge opens its own pages — a profile-sync notice, a first-run tab — and they
 * are `type: "page"` too. Attaching to the first one found means driving that
 * instead, and a privileged edge:// target silently refuses to navigate to
 * http, so the run looks fine while testing nothing.
 */
function pickPage(targets) {
  const pages = (targets || []).filter((t) => t.type === 'page');
  return pages.find((t) => t.url === 'about:blank')
    || pages.find((t) => !/^(edge|chrome|devtools):/i.test(t.url))
    || pages[0];
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout on ' + method)), 45000);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timer); ws.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(method + ': ' + JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main() {
  if (!BROWSER) throw new Error('usage: node tests/collect.cjs <browser>');
  const server = await serve();
  const base = `http://127.0.0.1:${SITE_PORT}${PUBLISHED_AT}`;
  const profile = path.join(os.tmpdir(), 'collect-' + Date.now());
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
    ws = await new Promise((resolve, reject) => {
      const target = pickPage(targets);
      if (!target) { reject(new Error('no page target')); return; }
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
        problems.push(msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
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
    await rpc(ws, id++, 'Page.navigate', { url: base });
    await new Promise((r) => setTimeout(r, 2500));

    /* ------------------------------------------------------------- picker */

    console.log('--- choosing a set ---');
    check('the browser is actually on the tracker',
      String(await evalJs('location.href')).startsWith(base), await evalJs('location.href'));

    const picker = JSON.parse(await evalJs(`JSON.stringify({
      sets: [...document.querySelectorAll('.set-card h2')].map(h => h.textContent),
      counts: [...document.querySelectorAll('.set-card-count')].map(c => c.textContent),
    })`));
    check('both sets are offered', picker.sets.length === 2, JSON.stringify(picker.sets));
    check('and each shows how far along it is',
      picker.counts.every((c) => /^0\/25$/.test(c)), JSON.stringify(picker.counts));

    /* --------------------------------------------------------- collection */

    console.log('\n--- opening Series 2 ---');
    await evalJs("location.hash = '#set=sw-galaxy-peek-s2'; 1");
    await new Promise((r) => setTimeout(r, 900));

    const grid = JSON.parse(await evalJs(`JSON.stringify({
      title: document.getElementById('title').textContent,
      subtitle: document.getElementById('subtitle').textContent,
      figures: document.querySelectorAll('.fig').length,
      progress: document.getElementById('progress-text').textContent,
      sourced: document.getElementById('sourced').textContent.slice(0, 60),
      unverifiedMarks: document.querySelectorAll('.fig.unverified').length,
      names: [...document.querySelectorAll('.fig-name')].map(n => n.textContent),
    })`));
    check('the right set opened', /Series 2/.test(grid.title), grid.title);
    check('the red capsule is named, so it is findable on a shelf',
      /Red Death Star/i.test(grid.subtitle), grid.subtitle);
    check('all 25 figures are on screen', grid.figures === 25, 'figures=' + grid.figures);
    check('progress starts at nothing', /0 of 25/.test(grid.progress), grid.progress);
    check('the roster says where it came from', grid.sourced.length > 20, grid.sourced);
    check('the two uncertain entries are marked as uncertain',
      grid.unverifiedMarks === 2, 'marked=' + grid.unverifiedMarks);

    // The research turned up AI summaries that confidently put Series 1's
    // ultra-rares in Series 2. If that ever creeps in, this catches it.
    const wrongSeries = ['Greedo', 'BB-8', 'Hera Syndulla', 'Chopper']
      .filter((n) => grid.names.some((g) => g.includes(n)));
    check('no Series 1 figures have leaked into Series 2',
      wrongSeries.length === 0, 'found: ' + wrongSeries.join(', '));
    check('the ultra rares are the Series 2 ones',
      ['Queen Amidala', 'Wrecker', 'Cad Bane', 'Boba Fett', 'Captain Phasma']
        .every((n) => grid.names.includes(n)),
      JSON.stringify(grid.names.slice(20)));

    /* ------------------------------------------------------------ finding */

    console.log('\n--- finding one ---');
    await evalJs("document.querySelectorAll('.fig')[20].click(); 1");
    await new Promise((r) => setTimeout(r, 400));
    const sheet = JSON.parse(await evalJs(`JSON.stringify({
      open: !document.getElementById('sheet').hidden,
      name: document.getElementById('sheet-name').textContent,
      rarity: document.getElementById('sheet-rarity').textContent,
      number: document.getElementById('sheet-number').textContent,
      codeNote: document.getElementById('code-note').textContent.slice(0, 40),
    })`));
    check('tapping a figure opens its card', sheet.open === true);
    check('showing the ultra rare it is', sheet.name === 'Queen Amidala' && /Ultra/.test(sheet.rarity),
      JSON.stringify(sheet));
    check('and its checklist number', /21/.test(sheet.number), sheet.number);
    check('with the note about where codes live', sheet.codeNote.length > 10, sheet.codeNote);

    await evalJs("document.getElementById('sheet-have').click(); 1");
    await new Promise((r) => setTimeout(r, 400));
    check('marking it found updates the count',
      /1 of 25/.test(await evalJs("document.getElementById('progress-text').textContent")),
      await evalJs("document.getElementById('progress-text').textContent"));
    check('and the card shows it', await evalJs("document.querySelectorAll('.fig.have').length") === 1);

    /* -------------------------------------------------------------- codes */

    console.log('\n--- writing down a code ---');
    await evalJs("window.prompt = () => ' p02 '; 1");
    await evalJs("document.getElementById('code-add').click(); 1");
    await new Promise((r) => setTimeout(r, 300));
    const codes = JSON.parse(await evalJs(`JSON.stringify(
      [...document.querySelectorAll('#code-list li')].map(li => li.textContent.replace('✕','')))`));
    check('the code is written down, tidied up', codes.includes('P02'), JSON.stringify(codes));

    await evalJs("document.getElementById('code-add').click(); 1");
    await new Promise((r) => setTimeout(r, 300));
    const again = await evalJs("document.querySelectorAll('#code-list li').length");
    check('adding the same code twice does not double it', again === 1, 'entries=' + again);

    /* ------------------------------------------------------------ spares */

    await evalJs("document.getElementById('dupe-up').click(); 1");
    await evalJs("document.getElementById('dupe-up').click(); 1");
    await new Promise((r) => setTimeout(r, 300));
    check('spares are counted', await evalJs("document.getElementById('dupe-count').textContent") === '2');
    check('and shown on the card', await evalJs("document.querySelectorAll('.fig-dupe').length") === 1);

    /* ------------------------------------------------------- it remembers */

    console.log('\n--- it remembers ---');
    await rpc(ws, id++, 'Page.navigate', { url: base + '#set=sw-galaxy-peek-s2' });
    await new Promise((r) => setTimeout(r, 2200));
    const after = JSON.parse(await evalJs(`JSON.stringify({
      progress: document.getElementById('progress-text').textContent,
      have: document.querySelectorAll('.fig.have').length,
      dupes: document.querySelectorAll('.fig-dupe').length,
    })`));
    check('progress survives a reload', /1 of 25/.test(after.progress) && after.have === 1,
      JSON.stringify(after));
    check('and so do the spares', after.dupes === 1);

    const stillCoded = await evalJs(`(() => {
      document.querySelectorAll('.fig')[20].click();
      return [...document.querySelectorAll('#code-list li')].map(li => li.textContent.replace('✕',''));
    })()`);
    check('and so does the code', String(stillCoded).includes('P02'), JSON.stringify(stillCoded));
    await evalJs("document.getElementById('sheet-close').click(); 1");

    /* --------------------------------------------------- the two sets differ */

    console.log('\n--- the other set is separate ---');
    await evalJs("location.hash = '#set=sw-galaxy-peek-s1'; 1");
    await new Promise((r) => setTimeout(r, 900));
    const s1 = JSON.parse(await evalJs(`JSON.stringify({
      title: document.getElementById('title').textContent,
      progress: document.getElementById('progress-text').textContent,
      names: [...document.querySelectorAll('.fig-name')].map(n => n.textContent),
    })`));
    check('Series 1 has its own untouched progress', /0 of 25/.test(s1.progress), s1.progress);
    check('and its own figures', s1.names.includes('Grogu') && s1.names.includes('Greedo'),
      JSON.stringify(s1.names.slice(0, 5)));
    check('which are not Series 2 figures', !s1.names.includes('Wrecker'));

    /* ------------------------------------------------------------ offline */

    console.log('\n--- offline, halfway down a shop aisle ---');
    const reg = await evalJs(`navigator.serviceWorker.ready.then(r => 'scope=' + r.scope)
      .catch(e => 'ERROR ' + e.message)`);
    check('the service worker takes over', /^scope=/.test(reg), reg);
    await new Promise((r) => setTimeout(r, 1500));

    check('no console errors during normal use', problems.length === 0,
      problems.slice(0, 3).join(' | '));
    const problemsBeforeOffline = problems.length;

    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    const probe = await evalJs(`fetch('${base}never-existed-' + Date.now())
      .then(r => r.status).catch(() => 'threw')`);
    check('the network really is down for the test that follows',
      probe === 504 || probe === 'threw', `a path that never existed answered ${probe}`);

    await rpc(ws, id++, 'Page.navigate', { url: base + '#set=sw-galaxy-peek-s2' });
    await new Promise((r) => setTimeout(r, 2500));
    const offline = JSON.parse(await evalJs(`JSON.stringify({
      figures: document.querySelectorAll('.fig').length,
      progress: document.getElementById('progress-text').textContent,
      have: document.querySelectorAll('.fig.have').length,
      styled: getComputedStyle(document.querySelector('.fig') || document.body).borderRadius,
    })`));
    check('the whole checklist opens with no network at all',
      offline.figures === 25 && /1 of 25/.test(offline.progress) && offline.have === 1,
      JSON.stringify(offline));
    check('including its styling', offline.styled === '16px', offline.styled);

    const offlineProblems = problems.slice(problemsBeforeOffline)
      .filter((p) => !/ERR_FAILED|ERR_CONNECTION|Failed to load resource/i.test(p));
    check('nothing broke offline beyond the fetch we killed on purpose',
      offlineProblems.length === 0, offlineProblems.slice(0, 3).join(' | '));

    console.log(fails === 0 ? '\nTRACKER VERIFIED \u2705' : `\n${fails} CHECK(S) FAILED`);
  } finally {
    if (ws) ws.close();
    try { process.kill(proc.pid); } catch { /* gone */ }
    if (server.listening) server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
