/**
 * Merging capsules that hold identical contents.
 *
 * The grouping rule is lifted out of hunt.js by source rather than copied, for
 * the same reason tests/sets.test.mjs lifts the tile rules: a copy of the rule
 * would pass happily while the page shipped a different one.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SETS = path.join(ROOT, 'sets');

function huntRules() {
  const src = fs.readFileSync(path.join(ROOT, 'hunt.js'), 'utf8');
  const grab = (name) => {
    const start = src.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`hunt.js no longer defines ${name}`);
    let depth = 0;
    let i = src.indexOf('{', start);
    const from = i;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') { depth -= 1; if (!depth) break; }
    }
    return src.slice(start, i + 1);
  };
  const byCodeSrc = src.match(/const byCode = [^;]+;/);
  if (!byCodeSrc) throw new Error('hunt.js no longer defines byCode');
  // eslint-disable-next-line no-new-func
  return new Function(`${byCodeSrc[0]}\n${grab('groupByContents')}\nreturn { groupByContents, byCode };`)();
}

const { groupByContents, byCode } = huntRules();

/** The sets as hunt.js assembles them, straight off disk. */
function loadSets() {
  const index = JSON.parse(fs.readFileSync(path.join(SETS, 'index.json'), 'utf8'));
  return index.map((meta) => {
    const set = JSON.parse(fs.readFileSync(path.join(SETS, meta.file), 'utf8'));
    const codeFile = set.codeFile || meta.codeFile;
    const full = codeFile && path.join(SETS, codeFile);
    const codes = full && fs.existsSync(full)
      ? (JSON.parse(fs.readFileSync(full, 'utf8')).codes || {})
      : {};
    return { id: meta.id, name: set.name, figures: set.figures, codes };
  });
}

const sets = loadSets();

test('every code still appears somewhere after merging', () => {
  for (const set of sets) {
    const before = Object.keys(set.codes);
    if (!before.length) continue;
    const after = groupByContents([set]).flatMap((g) => g.codes);
    assert.equal(new Set(after).size, after.length, `${set.id}: a code was emitted twice`);
    assert.deepEqual([...after].sort(), [...before].sort(),
      `${set.id}: merging lost or invented a code`);
  }
});

test('codes grouped together really do hold the same figures', () => {
  for (const set of sets) {
    const byId = new Map(set.figures.map((f) => [f.id, f]));
    for (const group of groupByContents([set])) {
      const expected = group.figures.map((f) => f.id).sort().join('|');
      for (const code of group.codes) {
        const actual = set.codes[code].map((id) => byId.get(id)).filter(Boolean)
          .map((f) => f.id).sort().join('|');
        assert.equal(actual, expected,
          `${set.id}: ${code} was merged into a capsule with different contents`);
      }
    }
  }
});

test('two capsules with different contents are never merged', () => {
  for (const set of sets) {
    const seen = new Map();
    for (const group of groupByContents([set])) {
      const key = group.figures.map((f) => f.id).sort().join('|');
      assert.ok(!seen.has(key), `${set.id}: ${key} produced two separate cards`);
      seen.set(key, true);
    }
  }
});

test('capsules from different series stay apart', () => {
  // Squish s1 and s2 share many figure ids; they are different products.
  const groups = groupByContents(sets);
  for (const group of groups) {
    assert.ok(group.set, 'a group lost its series');
  }
  const keys = groups.map((g) => `${g.set.id}\u0000${g.figures.map((f) => f.id).sort().join('|')}`);
  assert.equal(new Set(keys).size, keys.length, 'a series-scoped group was merged across series');
});

test('the merge actually collapses the duplication it exists for', () => {
  const totalCodes = sets.reduce((n, s) => n + Object.keys(s.codes).length, 0);
  const groups = groupByContents(sets).length;
  assert.ok(totalCodes > 900, `expected the real data, got ${totalCodes} codes`);
  assert.ok(groups < totalCodes / 3,
    `expected a big collapse, got ${groups} cards from ${totalCodes} codes`);
});

test('a capsule holding two of the same figure is not the same as holding one', () => {
  const set = {
    id: 'x', name: 'X',
    figures: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    codes: { ONE: ['a'], TWO: ['a', 'a'], MIX: ['a', 'b'] },
  };
  const groups = groupByContents([set]);
  assert.equal(groups.length, 3, 'duplicate-figure capsules were flattened together');
});

test('contents in a different order count as the same capsule', () => {
  const set = {
    id: 'x', name: 'X',
    figures: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    codes: { FIRST: ['a', 'b'], SECOND: ['b', 'a'] },
  };
  const groups = groupByContents([set]);
  assert.equal(groups.length, 1, 'the same capsule listed in another order was not merged');
  assert.deepEqual(groups[0].codes.sort(), ['FIRST', 'SECOND']);
});

test('a code naming figures that are not in the set is dropped, not shown empty', () => {
  const set = {
    id: 'x', name: 'X',
    figures: [{ id: 'a', name: 'A' }],
    codes: { GOOD: ['a'], GHOST: ['nobody'] },
  };
  const groups = groupByContents([set]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].codes, ['GOOD']);
});

test('codes read in natural order, so A2 comes before A10', () => {
  const sorted = ['A10', 'A2', 'B1', '10', '2'].sort(byCode);
  assert.deepEqual(sorted, ['2', '10', 'A2', 'A10', 'B1']);
});
