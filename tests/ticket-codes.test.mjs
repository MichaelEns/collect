import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../sets/${name}`, import.meta.url), 'utf8'));
const data = () => read('codes-disney-ticket-to-fun.json');

test('Ticket to Fun includes the newly published H-batch package codes', () => {
  const codes = data();
  assert.deepEqual(codes.codes.H010, ['alien', 'goofy', 'pinocchio', 'remy', 'tinker-bell']);
  assert.deepEqual(codes.codes.H048, ['ariel', 'cruella-de-vil', 'eeyore', 'remy', 'tigger']);
  assert.deepEqual(codes.codes.H052, ['alice', 'angel', 'chip', 'daisy-duck', 'lucifer', 'tiana']);
  assert.deepEqual(codes.codes.H066, [
    'belle', 'daisy-duck', 'elsa', 'mike-wazowski', 'timothy-mouse', 'winnie-the-pooh',
  ]);
  assert.deepEqual(codes.disputed.H038, [
    ['goofy', 'pinocchio'],
    ['buzz-lightyear', 'cheshire-cat', 'ducky', 'sulley', 'tramp'],
  ]);
});

test('Mini and Multi reports sharing an H code are both retained', () => {
  const codes = data();
  const expected = {
    H015: [
      ['bunny', 'goofy'],
      ['dale', 'heimlich', 'lady', 'piglet', 'rapunzel'],
    ],
    H021: [
      ['daisy-duck', 'mike-wazowski'],
      ['cruella-de-vil', 'donald-duck', 'minnie-mouse', 'olaf', 'stitch'],
    ],
    H029: [
      ['angel', 'eeyore', 'olaf'],
      ['jasmine', 'lotso', 'oogie-boogie', 'prince-naveen', 'tiana'],
    ],
    H033: [
      ['elsa', 'jessie', 'remy'],
      ['dale', 'emile', 'lady', 'rapunzel', 'sulley'],
    ],
    H036: [
      ['alice', 'olaf'],
      ['elsa', 'emile', 'lotso', 'marie', 'rapunzel'],
    ],
    H037: [
      ['leroy', 'sulley'],
      ['angel', 'ariel', 'ducky', 'finnick', 'jessie', 'lucifer', 'marie'],
    ],
    H042: [
      ['angel', 'finnick'],
      ['bunny', 'dale', 'evil-queen', 'goofy', 'piglet'],
    ],
    H045: [
      ['mike-wazowski', 'piglet', 'rapunzel'],
      ['donald-duck', 'hamm', 'jessie', 'minnie-mouse', 'olaf', 'stitch', 'timothy-mouse'],
    ],
  };
  for (const [code, variants] of Object.entries(expected)) {
    assert.equal(codes.codes[code], undefined, `${code} must not silently pick Mini or Multi`);
    assert.deepEqual(codes.disputed[code], variants, `${code} lost a reported package`);
  }
});

test('the H refresh keeps existing disagreements and accurate batch counts', () => {
  const codes = data();
  assert.deepEqual(codes.disputed.H040, [
    ['bunny', 'remy', 'tinker-bell'], ['remy', 'tinker-bell'],
  ]);
  assert.deepEqual(codes.disputed.H057, [
    ['donald-duck', 'goofy'], ['goofy', 'jessie'],
  ]);
  assert.equal(codes.batches.H, 65);
  const hCodes = Object.keys(codes.codes).filter((code) => code.startsWith('H'));
  const hDisputed = Object.keys(codes.disputed).filter((code) => code.startsWith('H'));
  assert.equal(hCodes.length, codes.batches.H);
  assert.equal(hDisputed.length, 11);
  assert.equal(hCodes.length + hDisputed.length, 76);
  assert.equal(codes.source.retrieved, '2026-11-15');
  assert.match(codes.source.notes, /H.batch.*2026-11-15/);
  assert.match(codes.source.notes, /All Ticket tab batches/);
  assert.match(codes.source.notes, /Previously shipped reports are retained/);
});
