/*
 * The merge is the only place sync can silently eat a child's collection, so
 * it gets tested harder than anything else here.
 *
 * The rules being defended:
 *   - a figure known to either side survives;
 *   - the newest edit to a figure wins, per figure;
 *   - un-ticking is a real edit and must propagate;
 *   - a device with a wrong clock cannot win forever;
 *   - rubbish in does not become rubbish stored.
 */
import test from 'node:test';
import assert from 'node:assert';

import {
  mergeAll, mergeEntry, mergeProgress, sanitiseEntry, sanitiseProgress, LIMITS,
} from '../worker/src/merge.js';
import { WORDS, makeCode, normaliseCode } from '../worker/src/code.js';

const NOW = 1_700_000_000_000;
const at = (t, over = {}) => ({ have: true, dupes: 0, codes: [], updatedAt: t, ...over });

test('a figure only one side knows about survives the merge', () => {
  // This is the property that makes a reinstall safe.
  const stored = { luke: at(5), rey: at(5) };
  const merged = mergeProgress(stored, {});
  assert.deepStrictEqual(Object.keys(merged).sort(), ['luke', 'rey']);
  assert.strictEqual(merged.luke.have, true);
});

test('a freshly installed device cannot wipe the collection', () => {
  // The exact disaster this design exists to prevent: new phone, same family
  // code, empty local storage, pushes first.
  const server = { 's2': { luke: at(9), rey: at(9), yoda: at(9) } };
  const merged = mergeAll(server, { 's2': {} }, NOW);
  assert.strictEqual(Object.keys(merged.s2).length, 3);
  assert.ok(Object.values(merged.s2).every((e) => e.have));
});

test('an empty push at all does not wipe anything', () => {
  const server = { 's2': { luke: at(9) } };
  assert.deepStrictEqual(mergeAll(server, {}, NOW), server);
  assert.deepStrictEqual(mergeAll(server, null, NOW), server);
  assert.deepStrictEqual(mergeAll(server, undefined, NOW), server);
});

test('the newest edit to a figure wins', () => {
  const stored = { luke: at(10, { dupes: 1 }) };
  const incoming = { luke: at(20, { dupes: 4 }) };
  assert.strictEqual(mergeProgress(stored, incoming).luke.dupes, 4);
  assert.strictEqual(mergeProgress(incoming, stored).luke.dupes, 4);
});

test('un-ticking propagates, rather than being resurrected', () => {
  // A union-everything merge would helpfully undo the removal. It must not.
  const stored = { luke: at(10, { have: true }) };
  const incoming = { luke: at(20, { have: false }) };
  assert.strictEqual(mergeProgress(stored, incoming).luke.have, false);
});

test('an older device cannot undo a newer edit', () => {
  const stored = { luke: at(50, { have: false }) };
  const incoming = { luke: at(20, { have: true }) };
  assert.strictEqual(mergeProgress(stored, incoming).luke.have, false);
});

test('a tie keeps what is already stored, so a repeated push is a no-op', () => {
  const stored = { luke: at(10, { dupes: 1 }) };
  const incoming = { luke: at(10, { dupes: 7 }) };
  assert.strictEqual(mergeProgress(stored, incoming).luke.dupes, 1);
});

test('merging is idempotent and order does not matter', () => {
  // Two devices syncing in either order must land in the same place, or they
  // will flip back and forth forever.
  const a = { s: { luke: at(10), rey: at(30) } };
  const b = { s: { luke: at(20), yoda: at(5) } };
  const ab = mergeAll(a, b, NOW);
  const ba = mergeAll(b, a, NOW);
  assert.deepStrictEqual(ab, ba);
  assert.deepStrictEqual(mergeAll(ab, b, NOW), ab);
  assert.deepStrictEqual(mergeAll(ab, a, NOW), ab);
});

test('two devices converge without either losing its own work', () => {
  // The realistic case: he ticks on the tablet, a parent ticks on the phone,
  // neither has seen the other yet.
  const tablet = { s2: { luke: at(100), rey: at(101) } };
  const phone = { s2: { yoda: at(102), jawa: at(103) } };
  const server = mergeAll(mergeAll({}, tablet, NOW), phone, NOW);
  assert.deepStrictEqual(Object.keys(server.s2).sort(), ['jawa', 'luke', 'rey', 'yoda']);
  assert.ok(Object.values(server.s2).every((e) => e.have));
});

test('a set only one device has ever opened is kept', () => {
  const server = { s1: { luke: at(1) } };
  const merged = mergeAll(server, { s5: { watto: at(2) } }, NOW);
  assert.deepStrictEqual(Object.keys(merged).sort(), ['s1', 's5']);
});

test('a clock running fast cannot win every merge forever', () => {
  /*
   * Without clamping, a tablet whose date is set to next year stamps every
   * edit with a timestamp nothing real can beat, and the collection freezes
   * at whatever that device last said.
   */
  const wayAhead = NOW + 365 * 24 * 3600 * 1000;
  const cleaned = sanitiseEntry(at(wayAhead, { dupes: 3 }), NOW);
  assert.ok(cleaned.updatedAt <= NOW + 5 * 60 * 1000, 'future timestamp was not clamped');

  const stored = { luke: cleaned };
  const laterReal = { luke: at(NOW + 10 * 60 * 1000, { dupes: 9 }) };
  assert.strictEqual(mergeProgress(stored, laterReal).luke.dupes, 9,
    'a real later edit still loses to the clamped one');
});

test('a small clock difference between devices is tolerated', () => {
  // Phones are NTP synced; a few seconds of skew is normal and must not be
  // treated as an attack.
  const slightly = sanitiseEntry(at(NOW + 30_000), NOW);
  assert.strictEqual(slightly.updatedAt, NOW + 30_000);
});

test('rubbish does not become stored state', () => {
  assert.strictEqual(sanitiseEntry(null, NOW), null);
  assert.strictEqual(sanitiseEntry('nope', NOW), null);
  assert.strictEqual(sanitiseEntry([], NOW), null);

  const messy = sanitiseEntry({
    have: 'yes', dupes: -4, codes: ['a 001', 'A001', 42, null, 'b#012'], updatedAt: 'soon',
  }, NOW);
  assert.strictEqual(messy.have, false, 'only a real true counts as found');
  assert.strictEqual(messy.dupes, 0, 'negative spares are impossible');
  assert.deepStrictEqual(messy.codes, ['A001', 'B012'], 'codes are tidied and de-duplicated');
  assert.strictEqual(messy.updatedAt, 0);
});

test('a huge push is bounded rather than stored whole', () => {
  const many = {};
  for (let i = 0; i < LIMITS.figures + 500; i += 1) many[`f-${i}`] = at(1);
  assert.strictEqual(Object.keys(sanitiseProgress(many, NOW)).length, LIMITS.figures);

  const longId = { ['x'.repeat(LIMITS.idLength + 1)]: at(1) };
  assert.deepStrictEqual(sanitiseProgress(longId, NOW), {});

  const manyCodes = { codes: Array.from({ length: 500 }, (_, i) => `A${i}`), updatedAt: 1 };
  assert.ok(sanitiseEntry(manyCodes, NOW).codes.length <= LIMITS.codesPerFigure);
});

test('mergeEntry handles a missing side without inventing one', () => {
  const e = at(1);
  assert.strictEqual(mergeEntry(undefined, e), e);
  assert.strictEqual(mergeEntry(e, undefined), e);
  assert.strictEqual(mergeEntry(undefined, undefined), undefined);
});

/* ------------------------------------------------------------ family codes */

test('the word list is big enough, and has no duplicates', () => {
  assert.strictEqual(new Set(WORDS).size, WORDS.length, 'a duplicate word costs entropy');
  assert.ok(WORDS.length >= 256, `only ${WORDS.length} words`);
  assert.ok(WORDS.every((w) => /^[a-z]{3,}$/.test(w)), 'words must be plain lowercase letters');
});

test('the word count divides 2^32, so no word is more likely than another', () => {
  // makeCode takes a Uint32 modulo the list length. If the length did not
  // divide 2^32 the early words would come up more often, quietly costing
  // entropy exactly where it is being counted on.
  assert.strictEqual(2 ** 32 % WORDS.length, 0,
    `${WORDS.length} words introduces modulo bias`);
});

test('a generated code is four known words and survives a round trip', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = makeCode();
    const parts = code.split('-');
    assert.strictEqual(parts.length, 4, code);
    assert.ok(parts.every((p) => WORDS.includes(p)), code);
    assert.strictEqual(normaliseCode(code), code);
  }
});

test('codes are not repeated', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(makeCode());
  assert.strictEqual(seen.size, 500, 'the generator is not random enough');
});

test('a code typed by a person is accepted, however they type it', () => {
  const code = makeCode();
  const [a, b, c, d] = code.split('-');
  assert.strictEqual(normaliseCode(`  ${a.toUpperCase()} ${b} ${c}  ${d} `), code);
  assert.strictEqual(normaliseCode(`${a}_${b}_${c}_${d}`), code);
  assert.strictEqual(normaliseCode(`${a}--${b}-${c}-${d}`), code);
});

test('a typo is rejected rather than silently starting an empty collection', () => {
  /*
   * This matters more than it looks. If a mistyped code were accepted, the app
   * would cheerfully sync with an empty collection that nobody else has — and
   * to a child that is indistinguishable from sync having deleted everything.
   */
  const [a, b, c] = makeCode().split('-');
  assert.strictEqual(normaliseCode(`${a}-${b}-${c}`), null, 'too few words');
  assert.strictEqual(normaliseCode(`${a}-${b}-${c}-${a}-${b}`), null, 'too many words');
  assert.strictEqual(normaliseCode(`${a}-${b}-${c}-notaword`), null, 'unknown word');
  assert.strictEqual(normaliseCode(`${a}-${b}-${c}-${a}x`), null, 'near miss');
  assert.strictEqual(normaliseCode(''), null);
  assert.strictEqual(normaliseCode(null), null);
  assert.strictEqual(normaliseCode(12345), null);
});
