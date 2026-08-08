/*
 * Checks the tracker is genuinely installable and genuinely works offline.
 *
 * This one gets used in a shop aisle, which is where the signal is worst, so
 * "works offline" is the feature rather than a nicety. All of these fail
 * silently in a browser and are invisible until the moment they matter.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const manifest = () => JSON.parse(read('manifest.webmanifest'));

const PUBLISHED_AT = '/collect/';

test('the manifest is valid JSON with everything an install needs', () => {
  const m = manifest();
  for (const key of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
    assert.ok(m[key], `manifest has no ${key}`);
  }
  assert.strictEqual(m.display, 'standalone');
  assert.ok(m.short_name.length <= 12, m.short_name);
});

test('every manifest URL is absolute, so nothing can resolve it wrongly', () => {
  const m = manifest();
  for (const u of [m.id, m.start_url, m.scope, ...m.icons.map((i) => i.src)]) {
    assert.ok(u.startsWith(PUBLISHED_AT), `"${u}" is not an absolute ${PUBLISHED_AT} path`);
    assert.ok(!u.includes('./'), `"${u}" still has a relative segment`);
  }
});

test('start_url sits inside scope, or it is not installable at all', () => {
  const m = manifest();
  const base = 'https://example.test/';
  assert.ok(new URL(m.start_url, base).href.startsWith(new URL(m.scope, base).href));
});

test('every icon exists, and the PNGs are the size they claim', () => {
  for (const icon of manifest().icons) {
    const file = path.join(ROOT, icon.src.replace(PUBLISHED_AT, ''));
    assert.ok(fs.existsSync(file), `missing icon: ${icon.src}`);
    if (!icon.src.endsWith('.png')) continue;
    const buf = fs.readFileSync(file);
    assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${icon.src} is not a PNG`);
    const [claimedW, claimedH] = icon.sizes.split('x').map(Number);
    assert.strictEqual(buf.readUInt32BE(16), claimedW, `${icon.src} width`);
    assert.strictEqual(buf.readUInt32BE(20), claimedH, `${icon.src} height`);
  }
});

test('there is a maskable icon, so Android does not letterbox it', () => {
  assert.ok(manifest().icons.some((i) => /maskable/.test(i.purpose || '')));
});

test('iOS is offered a PNG touch icon', () => {
  const m = read('index.html').match(/<link[^>]+rel="apple-touch-icon"[^>]+href="([^"]+)"/);
  assert.ok(m, 'no apple-touch-icon');
  assert.match(m[1], /\.png$/, `iOS was offered ${path.extname(m[1])}`);
  assert.ok(fs.existsSync(path.join(ROOT, m[1].replace(PUBLISHED_AT, ''))));
});

test('the theme colour in the page matches the manifest', () => {
  const m = read('index.html').match(/<meta\s+name="theme-color"\s+content="([^"]+)"/);
  assert.ok(m);
  assert.strictEqual(m[1].toLowerCase(), manifest().theme_color.toLowerCase());
});

test('every asset the page references is an absolute published path', () => {
  for (const m of read('index.html').matchAll(/(?:href|src)="(?!https?:|data:|#)([^"]+)"/g)) {
    assert.ok(m[1].startsWith(PUBLISHED_AT), `"${m[1]}" is relative`);
  }
});

test('the shell and the set index are precached', () => {
  // The set index is what the picker draws from. Leaving it out would give an
  // installed app an empty home screen the first time it opened offline.
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const wanted = new Set(['/collect/', '/collect/index.html', '/collect/styles.css',
    '/collect/app.js', '/collect/manifest.webmanifest', '/collect/sets/index.json']);
  for (const icon of manifest().icons) wanted.add(icon.src);
  const missing = [...wanted].filter((f) => !shell.includes(`'${f}'`));
  assert.deepStrictEqual(missing, [], `not precached: ${missing.join(', ')}`);
});

test('every set and its codes are precached, because the shop is where the signal dies', () => {
  /*
   * The capsule finder exists to be used standing in an aisle with a capsule in
   * hand. Fetching a set or its codes on first open would mean the one feature
   * built for that moment is the one feature that fails in it.
   *
   * This reads the index rather than a hardcoded list, so adding a sixth series
   * without making it available offline fails here.
   */
  const sw = read('sw.js');
  const shell = sw.slice(sw.indexOf('const SHELL'), sw.indexOf('];', sw.indexOf('const SHELL')));
  const index = JSON.parse(read('sets/index.json'));
  const missing = [];
  for (const meta of index) {
    const set = JSON.parse(read(`sets/${meta.file}`));
    for (const f of [meta.file, set.codeFile].filter(Boolean)) {
      if (!shell.includes(`'/collect/sets/${f}'`)) missing.push(f);
    }
  }
  assert.deepStrictEqual(missing, [], `not precached: ${missing.join(', ')}`);
});

test('the cache is versioned, or an update never reaches an installed copy', () => {
  assert.match(read('sw.js'), /const CACHE = '[\w-]+v\d+'/);
});

test('a navigation maps to the one page, fragment and all', () => {
  const sw = read('sw.js');
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /return '\/collect\/index\.html'/);
});

/* ------------------------------------------------------------ boundaries */

/** Every script the page actually ships. Miss one and the checks below lie. */
const SCRIPTS = ['app.js', 'sync.js', 'sync-ui.js', 'sw.js'];

test('the boundary checks cover every script the page loads', () => {
  /*
   * This guard exists because the privacy test below used to read app.js only.
   * Sync then arrived in a new file and sent data off the device without the
   * test noticing a thing. A list of filenames is worth nothing unless
   * something checks it against the page.
   */
  const html = read('index.html');
  const loaded = [...html.matchAll(/<script src="\/collect\/([^"]+)"/g)].map((m) => m[1]);
  const missing = loaded.filter((f) => !SCRIPTS.includes(f));
  assert.deepStrictEqual(missing, [],
    `index.html loads ${missing.join(', ')}, which no boundary test inspects`);
  assert.ok(SCRIPTS.includes('sw.js'), 'the service worker fetches too');
});

test('nothing leaves the device except to the one sync endpoint', () => {
  /*
   * No analytics, no CDN, no image host, no third party of any kind. The only
   * outbound address in the whole app is the family's own sync worker, and
   * only once sharing has been deliberately turned on.
   */
  const allowedHost = 'https://collect-sync.michaelens.workers.dev';
  for (const file of SCRIPTS) {
    const js = read(file);
    for (const m of js.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      assert.strictEqual(m[0], allowedHost,
        `${file} reaches out to ${m[0]}, which is not the sync endpoint`);
    }
    for (const m of js.matchAll(/fetch\(\s*[`'"]([^`'"]*)/g)) {
      const target = m[1];
      const ok = target.startsWith('/collect/') || target === allowedHost;
      assert.ok(ok, `${file} fetches "${target}"`);
    }
  }
});

test('sharing is off until it is switched on', () => {
  // An app for a six-year-old must not start shipping his collection anywhere
  // because he tapped something. Every request carries the family code, and
  // without a stored code there is nothing to carry and nothing is sent.
  const js = read('sync.js');
  assert.match(js, /if \(!getCode\(\)\)/,
    'sync must return early when no family code is stored');
  assert.match(js, /X-Family-Code/, 'requests are identified by the family code');
});

test('the sync endpoint is reached over https only', () => {
  const js = read('sync.js');
  const endpoint = /const ENDPOINT = '([^']+)'/.exec(js);
  assert.ok(endpoint, 'sync.js must name its endpoint in one place');
  assert.match(endpoint[1], /^https:\/\//, 'a family collection must not travel in the clear');
});

test('progress and photos are stored only on the device', () => {
  const js = read('app.js');
  assert.match(js, /localStorage/, 'progress should persist');
  assert.match(js, /indexedDB/, 'photos belong in IndexedDB, not localStorage');
});

test('photos are shrunk before they are stored', () => {
  // A few full-size phone photos would blow past the storage quota and start
  // throwing, taking the progress data down with them.
  assert.match(read('app.js'), /PHOTO_MAX_PX\s*=\s*\d+/);
});

test('no manufacturer artwork is bundled with the app', () => {
  // The only images shipped are the icons this repo draws itself.
  //
  // Screenshots are excluded because .gitignore already excludes them, so they
  // cannot reach anyone. Keeping them here would mean running the screenshot
  // tool breaks the build, which trains people to ignore this check — and this
  // check is the one standing between the app and someone else's copyright.
  const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignored, /^c-\*\.png$/m,
    '.gitignore no longer excludes screenshots, so this exemption is unsafe');

  const images = fs.readdirSync(ROOT)
    .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
    .filter((f) => !/^c-.*\.png$/i.test(f));
  const allowed = new Set(['icon-180.png', 'icon-512.png', 'icon-maskable-512.png']);
  const unexpected = images.filter((f) => !allowed.has(f));
  assert.deepStrictEqual(unexpected, [],
    `unexpected image files, which may be someone else's artwork: ${unexpected.join(', ')}`);
});
