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
    // Read the expected count off the index rather than pinning a number, so
    // adding a series does not fail a test that is not about counting.
    const expectedSets = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'sets', 'index.json'), 'utf8')
    ).length;
    check(`all ${expectedSets} sets are offered`,
      picker.sets.length === expectedSets, JSON.stringify(picker.sets));
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
      tiles: [...document.querySelectorAll('.fig-art')].map(n => n.textContent),
      faces: [...document.querySelectorAll('.fig')].map(c => [
        (c.querySelector('.fig-art') || {}).textContent || '',
        (c.querySelector('.fig-name') || {}).textContent || '',
        (c.querySelector('.fig-qual') || {}).textContent || '',
      ].join('|')),
      // textContent still holds text that CSS has clipped away, so the chips
      // are measured rather than read: a chip that rendered to nothing would
      // look fine to any check based on markup alone.
      quals: [...document.querySelectorAll('.fig-qual')]
        .map(n => ({ text: n.textContent, h: n.getBoundingClientRect().height })),
    })`));
    check('the right set opened', /Series 2/.test(grid.title), grid.title);
    check('the red capsule is named, so it is findable on a shelf',
      /Red Death Star/i.test(grid.subtitle), grid.subtitle);
    check('all 25 figures are on screen', grid.figures === 25, 'figures=' + grid.figures);
    check('progress starts at nothing', /0 of 25/.test(grid.progress), grid.progress);
    check('the roster says where it came from', grid.sourced.length > 20, grid.sourced);
    check('the two uncertain entries are marked as uncertain',
      grid.unverifiedMarks === 2, 'marked=' + grid.unverifiedMarks);

    /*
     * With no bundled artwork, the letters on a tile are the only thing
     * separating one unfound figure from another. Series 2 shipped two cards
     * both reading "AS" over "Anakin Skywalker…", which told a child that two
     * different figures were the same one.
     *
     * This reads the rendered DOM rather than the naming rule, because the
     * rule can be perfect and still not be the thing on screen.
     */
    const dupTiles = grid.tiles.filter((t, i) => grid.tiles.indexOf(t) !== i);
    check('no two tiles in the set show the same letters',
      dupTiles.length === 0, 'repeated: ' + JSON.stringify([...new Set(dupTiles)]));
    check('and no tile is blank or a stray bracket',
      grid.tiles.every((t) => /^[A-Z0-9]{2,4}$/.test(t)),
      JSON.stringify(grid.tiles.filter((t) => !/^[A-Z0-9]{2,4}$/.test(t))));

    const dupFaces = grid.faces.filter((f, i) => grid.faces.indexOf(f) !== i);
    check('no two whole cards read identically',
      dupFaces.length === 0, 'repeated: ' + JSON.stringify([...new Set(dupFaces)]));

    const anakins = grid.faces.filter((f) => /Anakin Skywalker/.test(f));
    check('the two Anakins are told apart on the card itself',
      anakins.length === 2 && anakins[0] !== anakins[1], JSON.stringify(anakins));
    check('and the thing telling them apart is actually drawn, not just present',
      grid.quals.length === 2 && grid.quals.every((q) => q.text && q.h > 4),
      JSON.stringify(grid.quals));

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

    /* ------------------------------------------- two routes racing */

    console.log('\n--- switching sets faster than they load ---');
    /*
     * Deterministic, not timing-dependent: the slow set's read is held open
     * while a second set is opened on top of it. Whichever finishes last, the
     * one the child actually asked for has to be the one on screen.
     *
     * This is a real bug that shipped and was caught offline, where the gap
     * between starting a read and finishing it is seconds wide.
     */
    await evalJs(`(() => {
      window.__realFetch = window.fetch;
      window.fetch = (u, o) => (/s1\\.json/.test(String(u))
        ? new Promise((res) => setTimeout(() => res(window.__realFetch(u, o)), 900))
        : window.__realFetch(u, o));
      return 1;
    })()`);
    await evalJs("location.hash = ''; 1");
    await new Promise((r) => setTimeout(r, 250));
    await evalJs("location.hash = '#set=sw-galaxy-peek-s1'; 1");
    await new Promise((r) => setTimeout(r, 120));
    await evalJs("location.hash = '#set=sw-galaxy-peek-s3'; 1");
    await new Promise((r) => setTimeout(r, 1800));
    const raced = JSON.parse(await evalJs(`JSON.stringify({
      title: document.getElementById('title').textContent,
      stateSet: (window.__collect.state.set || {}).id || null,
      first: (document.querySelector('.fig-name') || {}).textContent || null,
    })`));
    check('the set asked for last is the one shown',
      raced.stateSet === 'sw-galaxy-peek-s3' && /Series 3/.test(raced.title),
      JSON.stringify(raced));
    check('and its figures match its title, not the abandoned set',
      raced.first === 'Yoda', 'first figure: ' + raced.first);
    await evalJs('window.fetch = window.__realFetch; 1');
    // Put Series 2 back, since the checks that follow are written against it.
    await evalJs("location.hash = '#set=sw-galaxy-peek-s2'; 1");
    await new Promise((r) => setTimeout(r, 700));

    /* ------------------------------------------------- the capsule finder */

    console.log('\n--- the capsule finder ---');
    const typeCode = async (code) => {
      await evalJs(`(() => {
        const el = document.getElementById('code-input');
        el.value = ${JSON.stringify(code)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 1;
      })()`);
      await new Promise((r) => setTimeout(r, 220));
      return JSON.parse(await evalJs(`JSON.stringify({
        verdict: (document.querySelector('.finder-verdict') || {}).textContent || '',
        cls: (document.querySelector('.finder-verdict') || {}).className || '',
        chips: [...document.querySelectorAll('.chip-name')].map(c => c.textContent),
        want: document.querySelectorAll('.chip.want').length,
        have: document.querySelectorAll('.chip.have').length,
      })`));
    };

    const finderShown = await evalJs("String(!document.getElementById('finder').hidden)");
    check('the finder is offered when the set has codes', finderShown === 'true');

    // A001 is the first Series 2 capsule in the community sheet.
    const a001 = await typeCode('A001');
    check('a known code names its four figures',
      a001.chips.length === 4, JSON.stringify(a001.chips));
    check('and they are the four the sheet records',
      ['Anakin Skywalker (young)', 'Anakin Skywalker (Padawan)',
        'Clone Captain Rex', 'Queen Amidala'].every((n) => a001.chips.includes(n)),
      JSON.stringify(a001.chips));
    check('with a verdict about what is still missing',
      /still need/.test(a001.verdict) && /want/.test(a001.cls), a001.verdict);

    // Lower case, spaces and a stray dash must all reach the same capsule, or
    // a six-year-old typing carefully still gets told "unknown".
    const messy = await typeCode(' a-0 0 1 ');
    check('a messily typed code finds the same capsule',
      JSON.stringify(messy.chips) === JSON.stringify(a001.chips), JSON.stringify(messy.chips));

    const nonsense = await typeCode('ZZ999');
    check('an unrecorded code says so rather than guessing',
      /do not know/i.test(nonsense.verdict) && nonsense.chips.length === 0,
      nonsense.verdict);

    // Ticking a figure has to change the verdict, or the finder contradicts
    // the grid behind it.
    await evalJs("window.__collect.setHave('queen-amidala', true); 1");
    await new Promise((r) => setTimeout(r, 250));
    const afterTick = await typeCode('A001');
    check('the verdict drops as figures are found',
      afterTick.have === 1 && afterTick.want === 3, JSON.stringify(afterTick));
    await evalJs("window.__collect.setHave('queen-amidala', false); 1");
    await new Promise((r) => setTimeout(r, 250));
    await typeCode('');

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

    /*
     * Every capsule containing this figure is listed, with no truncation.
     * A capped list quietly answers "no" for the codes it hides, which is
     * exactly wrong when it is being checked against a capsule in hand.
     *
     * Checked against the worst case in the set rather than a convenient one:
     * Anakin (Padawan) is in 45 capsules across all 12 batches, so if the
     * layout survives him it survives anyone.
     */
    await evalJs("document.getElementById('sheet-close').click(); 1");
    await new Promise((r) => setTimeout(r, 300));
    await evalJs("window.__collect.openSheet("
      + "window.__collect.state.set.figures.find(f => f.id === 'anakin-padawan')); 1");
    await new Promise((r) => setTimeout(r, 500));
    const known = JSON.parse(await evalJs(`JSON.stringify({
      shown: [...document.querySelectorAll('#known-code-list .known-code')].map(c => c.textContent),
      batches: [...document.querySelectorAll('#known-code-list .batch-tag')].map(b => b.textContent),
      count: document.getElementById('known-code-more').textContent,
      truncated: /and \\d+ more/i.test(document.getElementById('known-codes').textContent),
    })`));
    const s2codes = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'sets', 'codes-sw-galaxy-peek-s2.json'), 'utf8'
    ));
    const expected = Object.entries(s2codes.codes)
      .filter(([, ids]) => ids.includes('anakin-padawan')).map(([c]) => c).sort();
    check('every capsule containing it is listed, not just the first few',
      JSON.stringify(known.shown.slice().sort()) === JSON.stringify(expected),
      `showed ${known.shown.length} of ${expected.length}`);
    check('nothing is hidden behind an "and N more"',
      known.truncated === false, known.count);
    check('and they are grouped by batch so the list stays scannable',
      known.batches.length === 12 && known.batches.every((b) => /^batch [A-Z]+$/.test(b)),
      `${known.batches.length} batch rows for ${known.shown.length} codes`);

    // Back to Queen Amidala, since the checks that follow are written for her.
    await evalJs("document.getElementById('sheet-close').click(); 1");
    await new Promise((r) => setTimeout(r, 300));
    await evalJs("document.querySelectorAll('.fig')[20].click(); 1");
    await new Promise((r) => setTimeout(r, 400));
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

    /*
     * Closing the server makes requests fail, but the machine still has a
     * network so navigator.onLine stays true — which is a weak-signal phone,
     * not the no-signal phone this app is built for. Telling the browser it is
     * offline as well gives the real case.
     *
     * Both are needed: emulateNetworkConditions does not reach a service
     * worker's own fetches, so without closing the server the worker would
     * still be served by the network it is supposedly cut off from.
     */
    await rpc(ws, id++, 'Network.enable', {});
    await rpc(ws, id++, 'Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
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

    /*
     * The finder is the reason everything is precached, so proving the
     * checklist survives offline is not enough — the lookup itself has to
     * answer. This is a set that was never opened while the network was up,
     * so its codes can only come from the precache.
     *
     * The figures are named explicitly. An earlier version of this check only
     * counted four chips, and passed while the page was still showing the
     * previous set entirely.
     */
    await evalJs("location.hash = '#set=sw-galaxy-peek-s4'; 1");
    // Timed, not merely awaited. This originally waited 1200ms and reported a
    // failure that was purely its own impatience: the service worker's network
    // timeout is 2500ms, so anything under that reads the previous set. The
    // worker now answers immediately when the device reports no connection,
    // and this asserts that rather than trusting it.
    const routeStart = Date.now();
    let routed = false;
    for (let i = 0; i < 40 && !routed; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      routed = (await evalJs(
        "String((window.__collect.state.set || {}).id === 'sw-galaxy-peek-s4')"
      )) === 'true';
    }
    const routeMs = Date.now() - routeStart;
    check('a set never opened online really opens offline', routed, `after ${routeMs}ms`);
    check('and it opens promptly, not after the network timeout',
      routed && routeMs < 2000, `took ${routeMs}ms, worker timeout is 2500ms`);

    await evalJs(`(() => {
      const el = document.getElementById('code-input');
      el.value = 'A001';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 350));
    const offlineFinder = JSON.parse(await evalJs(`JSON.stringify({
      shown: !document.getElementById('finder').hidden,
      title: document.getElementById('title').textContent,
      names: [...document.querySelectorAll('.fig-name')].map(n => n.textContent),
      chips: [...document.querySelectorAll('.chip-name')].map(c => c.textContent),
      verdict: (document.querySelector('.finder-verdict') || {}).textContent || '',
    })`));
    const s4 = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'sets', 'codes-sw-galaxy-peek-s4.json'), 'utf8'
    ));
    const s4set = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'sets', 'sw-galaxy-peek-s4.json'), 'utf8'
    ));
    const wantNames = s4.codes.A001.map((id) => s4set.figures.find((f) => f.id === id).name).sort();
    check('showing the right set, not the one before it',
      /Series 4/.test(offlineFinder.title) && offlineFinder.names.includes('Bail Organa'),
      offlineFinder.title + ' :: ' + offlineFinder.names.slice(0, 3).join(', '));
    check('and its capsule lookup answers with no network at all',
      JSON.stringify(offlineFinder.chips.slice().sort()) === JSON.stringify(wantNames),
      JSON.stringify(offlineFinder.chips) + ' want ' + JSON.stringify(wantNames));

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
