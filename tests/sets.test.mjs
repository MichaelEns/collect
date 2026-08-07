/*
 * Validates every collectible set file.
 *
 * These files are the whole point of the app: a wrong name or a wrong code is
 * a child being told something false about their own collection. Structure is
 * checked here; truthfulness is checked by the `verified` flags, which this
 * test makes sure are present and honest rather than decorative.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETS = path.join(ROOT, 'sets');

const read = (f) => JSON.parse(fs.readFileSync(path.join(SETS, f), 'utf8'));
const setFiles = () => fs.readdirSync(SETS)
  .filter((f) => f.endsWith('.json') && f !== 'index.json' && f !== 'FORMAT.json');

test('there is an index, and it lists every set file exactly once', () => {
  const index = read('index.json');
  assert.ok(Array.isArray(index), 'sets/index.json must be an array');
  const listed = index.map((s) => s.file).sort();
  assert.deepStrictEqual(listed, setFiles().sort(),
    'the index and the files on disk disagree, so a set is invisible or a link is dead');
});

test('every set in the index has what the picker needs to draw a card', () => {
  for (const meta of read('index.json')) {
    for (const key of ['id', 'file', 'name', 'brand', 'total']) {
      assert.ok(meta[key] !== undefined, `${meta.file || '?'} index entry has no ${key}`);
    }
    assert.ok(Number.isInteger(meta.total) && meta.total > 0, `${meta.id} has a silly total`);
  }
});

test('the index agrees with the set files it points at', () => {
  // The picker shows "3/12" from the index while the grid draws from the set.
  // If the totals disagree, the child is told two different things.
  for (const meta of read('index.json')) {
    const set = read(meta.file);
    assert.strictEqual(set.id, meta.id, `${meta.file}: id differs from the index`);
    assert.strictEqual(set.figures.length, meta.total,
      `${meta.file}: index says ${meta.total} figures, the file has ${set.figures.length}`);
  }
});

test('every set has the fields the app reads', () => {
  for (const file of setFiles()) {
    const set = read(file);
    for (const key of ['id', 'brand', 'name', 'figures']) {
      assert.ok(set[key], `${file} has no ${key}`);
    }
    assert.ok(Array.isArray(set.figures) && set.figures.length > 0, `${file} has no figures`);
  }
});

test('every figure has a stable, unique id', () => {
  // The id is the key progress is stored under. A duplicate silently merges
  // two figures; a missing one loses the child's progress on the next visit.
  for (const file of setFiles()) {
    const set = read(file);
    const seen = new Set();
    for (const figure of set.figures) {
      assert.ok(figure.id, `${file}: a figure has no id`);
      assert.match(figure.id, /^[a-z0-9][a-z0-9-]*$/,
        `${file}: "${figure.id}" is not a safe slug`);
      assert.ok(!seen.has(figure.id), `${file}: duplicate figure id "${figure.id}"`);
      seen.add(figure.id);
      assert.ok(figure.name, `${file}: figure "${figure.id}" has no name`);
    }
  }
});

test('every rarity a figure claims actually exists in its set', () => {
  for (const file of setFiles()) {
    const set = read(file);
    const known = new Set((set.rarities || []).map((r) => r.id));
    for (const figure of set.figures) {
      if (!figure.rarity) continue;
      assert.ok(known.has(figure.rarity),
        `${file}: "${figure.id}" claims rarity "${figure.rarity}", which the set does not define`);
    }
  }
});

test('every rarity has a label and a colour to draw it with', () => {
  for (const file of setFiles()) {
    for (const rarity of read(file).rarities || []) {
      assert.ok(rarity.id && rarity.label, `${file}: a rarity is missing id or label`);
      assert.match(rarity.colour || '', /^#[0-9a-f]{3,8}$/i,
        `${file}: rarity "${rarity.id}" has no usable colour`);
    }
  }
});

/* ------------------------------------------------------------- honesty */

test('every set says where its roster came from', () => {
  // Shown under the progress bar. A checklist with no stated source invites
  // more trust than it has earned.
  for (const file of setFiles()) {
    const set = read(file);
    assert.ok(set.sourced && set.sourced.length > 20,
      `${file}: no meaningful "sourced" note explaining where the data came from`);
  }
});

test('a set is only marked verified if every figure in it is', () => {
  for (const file of setFiles()) {
    const set = read(file);
    if (!set.verified) continue;
    const unverified = set.figures.filter((f) => f.verified === false).map((f) => f.id);
    assert.deepStrictEqual(unverified, [],
      `${file} claims to be verified but contains unconfirmed figures: ${unverified.join(', ')}`);
  }
});

test('a set that ships codes also ships the caveat about them', () => {
  // Packaging codes are community-derived and manufacturers change them. A
  // code presented with no caveat reads as a guarantee, and a child standing
  // in a shop will treat it as one.
  for (const file of setFiles()) {
    const set = read(file);
    const hasCodes = set.figures.some((f) => (f.codes || []).length > 0);
    if (!hasCodes) continue;
    assert.ok(set.codeCaveat && set.codeCaveat.length > 30,
      `${file} shows codes but has no codeCaveat explaining how reliable they are`);
  }
});

test('no set ships a code-to-figure mapping', () => {
  // The community does maintain these, but codes differ between production
  // batches and Just Play has never published them. A guessed mapping would
  // have a child put a capsule back on the shelf because the app told him the
  // wrong thing. Codes in this app are recorded by the child, from capsules
  // he actually opened, which is correct for his batch by construction.
  for (const file of setFiles()) {
    const set = read(file);
    for (const figure of set.figures) {
      assert.ok(!figure.codes,
        `${file}: "${figure.id}" ships packaging codes we cannot verify`);
    }
  }
});

test('a set that mentions codes explains where they are and how far to trust them', () => {
  for (const file of setFiles()) {
    const set = read(file);
    if (!set.codeNote) continue;
    assert.match(set.codeNote, /bottom/i, `${file}: codeNote does not say where to look`);
    assert.ok(/batch|change|never published|not published/i.test(set.codeNote),
      `${file}: codeNote does not say the codes are unofficial and can change`);
  }
});

test('a figure number is a printed checklist number, not a code', () => {
  // These two get conflated constantly. The number is on the paper checklist
  // inside; the code is moulded into the capsule outside. Labelling one as the
  // other would send a child looking in the wrong place.
  for (const file of setFiles()) {
    const set = read(file);
    if (!set.figures.some((f) => f.number)) continue;
    assert.ok(set.numberLabel, `${file}: figures have numbers but the set has no numberLabel`);
    assert.ok(set.numberNote && /checklist|inside/i.test(set.numberNote),
      `${file}: numberNote must say the number comes from the checklist inside the capsule`);
  }
});

test('nothing claims to be official artwork we are not allowed to ship', () => {
  // The app deliberately has no bundled product images. If a set file ever
  // grows an image field pointing at a manufacturer or retailer, that is a
  // copyright problem arriving quietly.
  for (const file of setFiles()) {
    const raw = fs.readFileSync(path.join(SETS, file), 'utf8');
    const set = JSON.parse(raw);
    for (const figure of set.figures) {
      assert.ok(!figure.image && !figure.img && !figure.art,
        `${file}: "${figure.id}" carries an image reference; art must be the child's own photo`);
    }
    for (const m of raw.matchAll(/"https?:\/\/[^"]+"/g)) {
      assert.ok(!/\.(png|jpe?g|webp|gif)"/i.test(m[0]),
        `${file} links directly to an image (${m[0]}); link to a page, not to artwork`);
    }
  }
});
