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

test('the cache is versioned, or an update never reaches an installed copy', () => {
  assert.match(read('sw.js'), /const CACHE = '[\w-]+v\d+'/);
});

test('a navigation maps to the one page, fragment and all', () => {
  const sw = read('sw.js');
  assert.match(sw, /request\.mode === 'navigate'/);
  assert.match(sw, /return '\/collect\/index\.html'/);
});

/* ------------------------------------------------------------ boundaries */

test('the app fetches nothing but its own set files', () => {
  // No analytics, no CDN, no image host. Everything about a child's collection
  // stays on the child's device.
  const js = read('app.js');
  for (const m of js.matchAll(/fetch\(\s*[`'"]([^`'"]*)/g)) {
    assert.ok(m[1].startsWith('/collect/'), `app.js fetches "${m[1]}"`);
  }
  for (const m of js.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
    assert.fail(`app.js reaches out to ${m[0]}`);
  }
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
  const images = fs.readdirSync(ROOT).filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
  const allowed = new Set(['icon-180.png', 'icon-512.png', 'icon-maskable-512.png']);
  const unexpected = images.filter((f) => !allowed.has(f));
  assert.deepStrictEqual(unexpected, [],
    `unexpected image files, which may be someone else's artwork: ${unexpected.join(', ')}`);
});
