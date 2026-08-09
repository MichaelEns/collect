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

// sets/ holds more than rosters: an index, a format note, and the id lock.
// Naming them keeps a new companion file from being mistaken for a set, which
// is how ids.lock.json first broke this suite.
const NOT_A_SET = new Set(['index.json', 'FORMAT.json', 'ids.lock.json']);
const allJson = () => fs.readdirSync(SETS)
  .filter((f) => f.endsWith('.json') && !NOT_A_SET.has(f));
const setFiles = () => allJson().filter((f) => !f.startsWith('codes-'));
const codeFiles = () => allJson().filter((f) => f.startsWith('codes-'));

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

test('a shipped code mapping says where it came from', () => {
  /*
   * Codes used to be banned from this app outright, on the grounds that they
   * differ between production batches. That was half right and wrongly acted
   * on: the letter at the front of a code IS the batch, and collectors have
   * mapped the batches, so a lookup keyed on the whole code is correct for
   * every batch it knows about.
   *
   * What still matters is that the data is attributable and that the app never
   * invents an answer. So rather than forbidding codes, this requires them to
   * carry provenance — and separate tests below require that disagreements are
   * preserved instead of resolved by guesswork.
   */
  for (const file of codeFiles()) {
    const data = read(file);
    assert.ok(data.source, `${file}: ships codes with no source`);
    for (const key of ['title', 'credit', 'url', 'retrieved']) {
      assert.ok(data.source[key], `${file}: source has no ${key}`);
    }
    assert.match(data.source.url, /^https:\/\//, `${file}: source url is not a link`);
    assert.match(data.source.retrieved, /^\d{4}-\d{2}-\d{2}$/,
      `${file}: retrieved date is not a plain date`);
  }
});

test('every shipped code names four real figures from its own set', () => {
  // A code pointing at a figure that is not in the set would render a blank
  // chip, and a capsule of three would quietly mislead.
  for (const file of codeFiles()) {
    const data = read(file);
    const set = read(`${data.setId}.json`);
    const ids = new Set(set.figures.map((f) => f.id));
    const seen = Object.entries(data.codes);
    assert.ok(seen.length > 0, `${file}: ships no codes at all`);
    for (const [code, figures] of seen) {
      assert.strictEqual(figures.length, set.figuresPerCapsule || 4,
        `${file}: code ${code} does not hold a full capsule`);
      assert.strictEqual(new Set(figures).size, figures.length,
        `${file}: code ${code} lists the same figure twice`);
      for (const id of figures) {
        assert.ok(ids.has(id), `${file}: code ${code} names "${id}", which is not in ${data.setId}`);
      }
    }
  }
});

test('codes look like codes, and none is both agreed and disputed', () => {
  for (const file of codeFiles()) {
    const data = read(file);
    const disputed = data.disputed || {};
    for (const code of Object.keys(data.codes)) {
      assert.match(code, /^[A-Z0-9]+$/, `${file}: "${code}" is not a plain code`);
      assert.ok(!(code in disputed), `${file}: ${code} is listed as both settled and disputed`);
    }
  }
});

test('a disputed code keeps every version rather than picking one', () => {
  // Silently choosing a side would tell a child something false with total
  // confidence. Showing both is honest and still useful.
  for (const file of codeFiles()) {
    const data = read(file);
    for (const [code, variants] of Object.entries(data.disputed || {})) {
      assert.ok(Array.isArray(variants) && variants.length > 1,
        `${file}: ${code} is filed as disputed but has fewer than two versions`);
      const seen = new Set(variants.map((v) => [...v].sort().join('|')));
      assert.strictEqual(seen.size, variants.length,
        `${file}: ${code} lists the same version twice`);
    }
  }
});

test('every set the codes claim to describe actually exists', () => {
  const files = new Set(setFiles());
  for (const file of codeFiles()) {
    const data = read(file);
    assert.ok(data.setId, `${file}: has no setId`);
    assert.ok(files.has(`${data.setId}.json`), `${file}: points at a set that does not exist`);
    assert.strictEqual(file, `codes-${data.setId}.json`,
      `${file}: is named for a different set than it declares`);
  }
});

test('a set that points at a code file gets one, and vice versa', () => {
  for (const file of setFiles()) {
    const set = read(file);
    if (!set.codeFile) continue;
    assert.ok(fs.existsSync(path.join(SETS, set.codeFile)),
      `${file}: names a code file that is not there, so the finder silently vanishes`);
  }
});

test('a set that mentions codes explains where they are and how far to trust them', () => {
  for (const file of setFiles()) {
    const set = read(file);
    if (!set.codeNote) continue;
    assert.match(set.codeNote, /bottom/i, `${file}: codeNote does not say where to look`);
    // The batch letter is the whole reason a code can come back unknown. If
    // the note does not explain it, an unknown code reads as the app being
    // broken rather than as a batch nobody has recorded yet.
    assert.match(set.codeNote, /batch/i,
      `${file}: codeNote does not explain that the leading letter is the batch`);
    assert.ok(/not official|unofficial|never published|collectors/i.test(set.codeNote),
      `${file}: codeNote does not say the codes are unofficial`);
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

/*
 * Because there is no bundled artwork, the two or three letters on a tile are
 * the ONLY thing distinguishing one unfound figure from another. Two tiles
 * reading the same thing is therefore not cosmetic — it is the app telling a
 * child that two different figures are the same one.
 *
 * The rule lives in app.js, which is a browser IIFE, so the functions are
 * lifted out by source rather than imported. That is deliberate: testing a
 * copy of the rule would pass happily while the app shipped a different one.
 */
function tileRules() {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    assert.ok(start !== -1, `app.js no longer defines ${name}(); the tile test needs updating`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    throw new Error(`could not read ${name}() out of app.js`);
  };
  const names = ['tagCandidates', 'assignTags', 'qualifierOf', 'baseName'];
  // eslint-disable-next-line no-new-func
  return new Function(`${names.map(grab).join('\n')}\nreturn {${names.join(',')}};`)();
}

test('no two figures in a set show the same tile', () => {
  const { assignTags } = tileRules();
  for (const file of setFiles()) {
    const set = read(file);
    const tags = assignTags(set.figures);
    const seen = new Map();
    for (const figure of set.figures) {
      const tag = tags.get(figure.id);
      assert.ok(tag, `${file}: "${figure.id}" got no tile at all`);
      assert.ok(!seen.has(tag),
        `${file}: "${figure.name}" and "${seen.get(tag)}" both show "${tag}"`);
      seen.set(tag, figure.name);
    }
  }
});

test('a tile is letters and digits, never a stray bracket or quote', () => {
  // The previous rule took the first character of the second word, so
  // "Chopper (C1-10P)" rendered as "C(" and Garazeb "Zeb" Orrelios as 'G"'.
  const { assignTags } = tileRules();
  for (const file of setFiles()) {
    const set = read(file);
    const tags = assignTags(set.figures);
    for (const figure of set.figures) {
      const tag = tags.get(figure.id);
      assert.match(tag, /^[A-Z0-9]{2,4}$/,
        `${file}: "${figure.name}" renders as "${tag}", which is not a readable tile`);
    }
  }
});

test('no two cards in a set look the same to a child', () => {
  /*
   * Series 2 shipped two figures both reading "AS" and both clamped to
   * "Anakin Skywalker…", so nothing on either card told them apart.
   *
   * What a card actually shows is the tile, the name without its bracket, and
   * the bracket as a separate chip. All three together must be unique — a
   * missing chip is itself a distinction ("Princess Leia" vs the same name
   * plus a "hologram" chip), so the rule is about the whole card, not about
   * every variant carrying a label.
   */
  const { assignTags, qualifierOf, baseName } = tileRules();
  for (const file of setFiles()) {
    const set = read(file);
    const tags = assignTags(set.figures);
    const seen = new Map();
    for (const figure of set.figures) {
      const face = JSON.stringify([
        tags.get(figure.id),
        baseName(figure.name).toLowerCase(),
        qualifierOf(figure.name).toLowerCase(),
      ]);
      assert.ok(!seen.has(face),
        `${file}: "${figure.name}" and "${seen.get(face)}" draw an identical card`);
      seen.set(face, figure.name);
    }
  }
});

test('two figures sharing a name are separated by more than the tile alone', () => {
  // A tile is two or three letters and easy to misread, so where two figures
  // share a base name the words on the card must differ too.
  const { qualifierOf, baseName } = tileRules();
  for (const file of setFiles()) {
    const set = read(file);
    const byBase = new Map();
    for (const figure of set.figures) {
      const base = baseName(figure.name).toLowerCase();
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(figure);
    }
    for (const [base, members] of byBase) {
      if (members.length < 2) continue;
      const labels = members.map((f) => qualifierOf(f.name).toLowerCase());
      assert.strictEqual(new Set(labels).size, labels.length,
        `${file}: two figures called "${base}" carry the same label "${labels[0]}"`);
    }
  }
});

/*
 * The id lock.
 *
 * An id is not an implementation detail: progress is stored as
 * `collect.progress.<setId>` -> `{ <figureId>: entry }`, in the browser and in
 * the shared store, so the id IS the thing remembering that a figure was
 * found. Rosters are rebuilt from a community spreadsheet whose spelling we do
 * not control, and build_codes.cjs carries ids across BY NAME — so a sheet
 * that respells a figure mints a new id and abandons the old one silently.
 *
 * Adding ids is always fine. These tests only care about ids going missing.
 */
const LOCK = 'ids.lock.json';

test('every set points at its own wiki page, not somebody else\'s', () => {
  /*
   * All five sets used to link to the Series 2 page, so four times out of five
   * the app sent you to the wrong checklist — and that link is the one route
   * from the app to a picture of the figure you are hunting.
   *
   * The page titles are genuinely inconsistent (Series 3 and 4 are not called
   * "Galaxy Peek" on the wiki), so this cannot be checked by pattern-matching
   * the series number. What it can check is that no two sets share a link,
   * which is what actually went wrong.
   */
  const seen = new Map();
  for (const meta of read('index.json')) {
    const set = read(meta.file);
    if (!set.codeLink) continue;
    assert.ok(!seen.has(set.codeLink),
      `${meta.id} and ${seen.get(set.codeLink)} both link to ${set.codeLink};`
      + ' one of them is sending a child to the wrong series');
    seen.set(set.codeLink, meta.id);
  }
});

test('every figure appears in at least one known capsule code', () => {
  /*
   * A figure no code names is one the finder can never help with: type any
   * code you like and it will never say "this one has Yoda in it".
   *
   * This is the shape the Series 1 outage took. The builder matched only rows
   * marked "Galaxy" while the sheet also marks them "Multi" and "Series 1", so
   * Series 1 shipped 12 codes out of 292 and left five figures uncoverable —
   * silently, because 12 codes still looks like a working feature.
   */
  for (const file of setFiles()) {
    const set = read(file);
    if (!set.codeFile) continue;
    const codes = read(set.codeFile);
    const covered = new Set();
    for (const ids of Object.values(codes.codes || {})) for (const id of ids) covered.add(id);
    for (const variants of Object.values(codes.disputed || {})) {
      for (const ids of variants) for (const id of ids) covered.add(id);
    }
    const orphans = set.figures.filter((f) => !covered.has(f.id)).map((f) => f.name);
    assert.deepStrictEqual(orphans, [],
      `${file}: no capsule code names ${orphans.join(', ')}, so the finder can never find them`);
  }
});

test('the id lock covers every set that exists', () => {
  const lock = read(LOCK);
  assert.ok(lock && lock.sets, 'sets/ids.lock.json is missing or malformed');
  for (const meta of read('index.json')) {
    assert.ok(lock.sets[meta.id],
      `${meta.id} is not in the id lock; run \`node tools/lock_ids.cjs --write\``);
  }
});

test('no id progress is stored against has disappeared', () => {
  const lock = read(LOCK);
  const byId = new Map(read('index.json').map((m) => [m.id, m.file]));
  for (const [setId, ids] of Object.entries(lock.sets)) {
    const file = byId.get(setId);
    assert.ok(file,
      `set "${setId}" is in the lock but gone from the index; every tick in it is orphaned`);
    const have = new Set(read(file).figures.map((f) => f.id));
    for (const id of ids) {
      assert.ok(have.has(id),
        `"${id}" is in the lock but no longer in ${file}. Anyone who found it loses that tick — `
        + 'keep the old id on the renamed figure rather than reslugging it.');
    }
  }
});

test('a locked id is never quietly reused for a different figure', () => {
  // Two figures sharing an id would merge two children's ticks into one.
  const lock = read(LOCK);
  for (const [setId, ids] of Object.entries(lock.sets)) {
    assert.strictEqual(new Set(ids).size, ids.length,
      `${setId} lists the same id twice in the lock`);
  }
});
