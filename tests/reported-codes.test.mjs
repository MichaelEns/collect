import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../sets/${name}`, import.meta.url), 'utf8'));

test('the full Ticket refresh includes every audited missing code and alternative', () => {
  const data = read('codes-disney-ticket-to-fun.json');
  const added = `
    027 029 070 073 074 078 102 104 105 159 J065 K072 K118
    L012 L019 L036 L040 L042 L044 L046 L051 L054 L056 L057 L061 L065
    L066 L067 L068 L069 L070 L071 L073 L075 L104 L114 L124 L142 L155 L156 L159
    M015 M016 M017 M022 M032 M039 M041 M043 M045 M047 M049 M051 M053 M055
    M057 M058 M059 M061 M063 M065 M066 M067 M069 M071 M073 M074 M080 M082
    M107 M112 M117 M122 M127 M132 M145 M148 M151 M154 M159 M168 M171 M184
    MO019 MO026 MO034 MO036 MO074 MO079 N133 N197 N232
    O037 O039 O049 O051 O056 O059 O060 O078 O080 O095 O096 O098 O112 O113
    O115 O122 O129 O132 O140 O141 O142 O143 O145 O149 O150 O158
    P017 P026 P028 P030 P034 P039 P046 P049 P050 P052 P057 P059 P061 P063
    P064 P069 P075 P096 P106 P113 P114 P116 P122 P130 P131 P132 P134 P137
    P153 P159 P165 P177 Q027
    F009 F011 F012 F015 F050 G001 G004 G007 G010 G013 G014 G020 G022 G025
    G031 G036 G040 G042 G044 G045 G047
  `.trim().split(/\s+/);
  assert.equal(added.length, 172);
  assert.equal(new Set(added).size, 172);
  for (const code of added) assert.ok(data.codes[code] || data.disputed[code], code);
  for (const code of `
    075 E016 F024 F032 F038 F044 F054 F056 G017 G023 G026 G028 G032
    G034 G035 G038 G039 G041 G048 G051 K049 L050 L129 L145 E048 F025
  `.trim().split(/\s+/)) {
    assert.ok(data.disputed[code]?.length > 1, `${code} must retain alternative reports`);
    assert.equal(data.codes[code], undefined);
  }
  for (const code of ['O060', 'P113', 'G004', 'G045']) {
    assert.ok(data.disputed[code]?.length > 1, `${code} must not select one conflicting report`);
  }
  assert.equal(Object.keys(data.codes).length, 952);
  assert.equal(Object.keys(data.disputed).length, 138);
  assert.equal(data.source.retrieved, '2026-11-15');
});

test('the additional Galaxy Peek and Cruisers codes name the recorded figures', () => {
  const galaxy = read('codes-sw-galaxy-peek-s5.json');
  assert.deepEqual(galaxy.codes.B011, ['darth-maul', 'leia', 'luke-skywalker', 'porg']);
  assert.deepEqual(galaxy.codes.B019, ['4-lom', 'emperor-palpatine', 'jango-fett', 'watto']);
  assert.deepEqual(galaxy.codes.B023, ['4-lom', 'aurra-sing', 'jango-fett', 'supreme-leader-snoke']);
  assert.equal(Object.keys(galaxy.codes).length, 66);
  const cruisers = read('codes-sw-cruisers-s1.json');
  assert.deepEqual(cruisers.codes.I010, ['ahsoka-tano']);
  assert.equal(Object.keys(cruisers.codes).length, 127);
});

test('Grogu Moments keeps the two conflicting C011 scenes separate', () => {
  const data = read('codes-sw-grogu-moments.json');
  assert.deepEqual(data.codes.C010, ['frogs']);
  assert.deepEqual(data.disputed.C011, [['classroom'], ['droids']]);
  assert.equal(data.codes.C011, undefined);
  assert.deepEqual(data.codes.C013, ['boar']);
  assert.deepEqual(data.codes.C014, ['meditate']);
  assert.deepEqual(data.codes.C015, ['spider-eggs']);
  assert.deepEqual(data.codes.C016, ['stormtroopers']);
  assert.deepEqual(data.codes.C017, ['classroom']);
  assert.equal(Object.keys(data.codes).length, 40);
});

test('Grogu Mini exposes partial codes without pretending its full checklist is mapped', () => {
  const set = read('sw-grogu-mini.json');
  const data = read(set.codeFile);
  const meta = read('index.json').find((entry) => entry.id === set.id);
  assert.equal(meta.codeFile, set.codeFile);
  assert.equal(set.figures.length, 12);
  assert.deepEqual(data.codes.TL001, ['anzellan-hug']);
  assert.deepEqual(data.disputed.C017, [['anzellan-hug'], ['macaron-cookie']]);
  assert.equal(data.codes.C017, undefined);
  assert.equal(set.unmappedFigureIds.length, 10);
  assert.match(set.countNote, /only 2 of the 12/);
  assert.match(set.codeNote, /C017.*both alternatives/);
});

test('batch-less Toy Story submissions do not gain invented package identities', () => {
  const data = read('codes-ts-rerelease.json');
  for (const code of ['035', '35', '042', '42']) {
    assert.equal(data.codes[code], undefined);
    assert.equal(data.disputed[code], undefined);
  }
});
