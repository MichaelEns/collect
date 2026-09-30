'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DoorablesError,
  DoorablesService,
  capsuleCodeAsrCandidates,
  codeDataCandidates,
  figureCodesSpeech,
  lookupSpeech,
  needSpeech,
  normaliseCapsuleCode,
  normaliseFamilyCode,
  resolvePackage,
} = require('../alexa/lambda/doorables');

const SYNC = 'https://sync.example/v1/collection';
const DATA = 'https://data.example/sets';
const INDEX = [
  { id: 'sw-galaxy-peek-s1', name: 'Galaxy Peek Series 1', file: 's1.json' },
  { id: 'sw-galaxy-peek-s2', name: 'Galaxy Peek Series 2', file: 's2.json' },
  { id: 'sw-galaxy-peek-s3', name: 'Galaxy Peek Series 3', file: 's3.json' },
  { id: 'ts-small-stars-s1', name: 'Small Stars Series 1', file: 'b1.json' },
  { id: 'ts-small-stars-s2', name: 'Small Stars Series 2', file: 'b2.json' },
  { id: 'ts-small-stars-s3', name: 'Small Stars Series 3', file: 'b3.json' },
];
const S1 = {
  id: 'sw-galaxy-peek-s1',
  codeFile: 'codes-s1.json',
  figures: [
    { id: 'chopper', name: 'Chopper' },
    { id: 'han-solo', name: 'Han Solo' },
    { id: 'princess-leia', name: 'Princess Leia' },
    { id: 'professor-huyang', name: 'Professor Huyang' },
  ],
};
const S2 = {
  id: 'sw-galaxy-peek-s2',
  codeFile: 'codes-s2.json',
  figures: [
    { id: 'anakin', name: 'Anakin Skywalker' },
    { id: 'rex', name: 'Clone Captain Rex' },
    { id: 'amidala', name: 'Queen Amidala' },
  ],
};
const S3 = {
  id: 'sw-galaxy-peek-s3',
  codeFile: 'codes-s3.json',
  figures: [
    { id: 'grogu', name: 'Grogu' },
    { id: 'ki-adi-mundi', name: 'Ki-Adi-Mundi' },
    { id: 'mae-assassin', name: 'Mae (Assassin)' },
    { id: 'yoda', name: 'Yoda' },
  ],
};

function mockFetch(responses) {
  return async (url) => {
    const response = responses.get(String(url));
    if (!response) throw new Error(`Unexpected URL: ${url}`);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      async json() {
        return response.body;
      },
    };
  };
}

function serviceWith(progress = {}, series3Codes = {
  A001: ['grogu', 'ki-adi-mundi', 'mae-assassin', 'yoda'],
}) {
  const responses = new Map([
    [SYNC, { status: 200, body: { progress } }],
    [`${DATA}/index.json`, { status: 200, body: INDEX }],
    [`${DATA}/s1.json`, { status: 200, body: S1 }],
    [`${DATA}/s2.json`, { status: 200, body: S2 }],
    [`${DATA}/s3.json`, { status: 200, body: S3 }],
    [`${DATA}/codes-s1.json`, {
      status: 200,
      body: {
        codes: {
          4: ['chopper'],
          I008: ['chopper', 'han-solo', 'princess-leia', 'professor-huyang'],
          O017: ['han-solo'],
        },
        disputed: {
          O004: [['chopper', 'han-solo'], ['chopper', 'princess-leia']],
        },
      },
    }],
    [`${DATA}/codes-s2.json`, {
      status: 200,
      body: {
        codes: {
          B003: ['anakin', 'amidala'],
          C005: ['amidala', 'rex'],
        },
        disputed: {
          A001: [['anakin', 'rex'], ['anakin', 'amidala']],
        },
      },
    }],
    [`${DATA}/codes-s3.json`, {
      status: 200,
      body: {
        codes: series3Codes,
      },
    }],
  ]);
  return new DoorablesService({
    fetch: mockFetch(responses),
    syncEndpoint: SYNC,
    dataBase: DATA,
  });
}

test('a four-word sharing code is normalized against the real vocabulary', () => {
  assert.equal(normaliseFamilyCode('Astro Badger_Delta--Squid'),
    'astro-badger-delta-squid');
  assert.equal(normaliseFamilyCode('only three words'), null);
  assert.equal(normaliseFamilyCode('astro badger delta notaword'), null);
});

test('compound family words survive Alexa inserting spaces', () => {
  assert.equal(normaliseFamilyCode('blue jay pine cone light house snow drop'),
    'bluejay-pinecone-lighthouse-snowdrop');
});

test('Alexa and the worker use the same family-code vocabulary', () => {
  const workerSource = fs.readFileSync(
    path.join(__dirname, '..', 'worker', 'src', 'code.js'), 'utf8');
  const wordBlock = workerSource.match(/export const WORDS = \[([\s\S]*?)\];/);
  assert.ok(wordBlock, 'worker family-code vocabulary was not found');
  const workerWords = [...wordBlock[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const alexaWords = require('../alexa/lambda/family-words.json');
  assert.deepEqual(alexaWords, workerWords);
});

test('packaging language resolves to the intended set', () => {
  assert.deepEqual(resolvePackage('red Death Star guys').packageInfo.setIds,
    ['sw-galaxy-peek-s2']);
  assert.deepEqual(resolvePackage('grey Death Star').packageInfo.setIds,
    ['sw-galaxy-peek-s1']);
  assert.deepEqual(resolvePackage('purple Toy Story backpacks').packageInfo.setIds,
    ['ts-small-stars-s3']);
  assert.deepEqual(resolvePackage('blue cargo capsule').packageInfo.setIds,
    ['sw-galaxy-peek-s3']);
});

test('an uncolored Toy Story backpack prompts instead of guessing a wave', () => {
  const resolution = resolvePackage('Toy Story backpacks');
  assert.equal(resolution.status, 'ambiguous');
  assert.match(resolution.speech, /blue, green, or purple/);
});

test('spoken capsule codes match the app leading-zero semantics', () => {
  assert.equal(normaliseCapsuleCode('I eight'), 'I8');
  assert.equal(normaliseCapsuleCode('eye zero zero eight'), 'I8');
  assert.equal(normaliseCapsuleCode('A zero zero one'), 'A1');
  assert.equal(normaliseCapsuleCode('eighty three'), '83');
  assert.equal(normaliseCapsuleCode('oh four'), 'O4');
});

test('a numeric Alexa transcription can recover a leading letter A', () => {
  assert.deepEqual(capsuleCodeAsrCandidates(['81']), ['A1']);
  assert.deepEqual(capsuleCodeAsrCandidates(['801']), ['A1']);
  assert.deepEqual(capsuleCodeAsrCandidates(['1', 'I8']), []);
});

test('Alexa recovery follows the package code format instead of guessing globally', () => {
  assert.deepEqual(codeDataCandidates(['81'], {
    codes: { A001: ['one'] },
  }), ['A1']);
  assert.deepEqual(codeDataCandidates(['A11'], {
    codes: { '01': ['one'], '11': ['eleven'] },
  }), ['11']);
  assert.deepEqual(codeDataCandidates(['811'], {
    codes: { '075': ['bare'], A011: ['lettered'] },
  }), []);
});

test('blue cargo capsule code 81 falls back to A1 when no numeric code exists', async () => {
  const service = serviceWith({});
  const packageInfo = resolvePackage('blue cargo capsule').packageInfo;
  const result = await service.lookup(packageInfo, '81', {});
  assert.equal(result.code, 'A1');
  assert.deepEqual(result.entries[0].variants[0].names,
    ['Grogu', 'Ki-Adi-Mundi', 'Mae (Assassin)', 'Yoda']);
});

test('a real numeric code takes precedence over an Alexa letter recovery', async () => {
  const service = serviceWith({}, {
    81: ['yoda'],
    A001: ['grogu', 'ki-adi-mundi', 'mae-assassin', 'yoda'],
  });
  const packageInfo = resolvePackage('blue cargo capsule').packageInfo;
  const result = await service.lookup(packageInfo, '81', {});
  assert.equal(result.code, '81');
  assert.deepEqual(result.entries[0].variants[0].names, ['Yoda']);
});

test('numeric-only packages ignore a spurious Alexa letter and keep one-figure counts', async () => {
  const responses = new Map([
    [`${DATA}/index.json`, {
      status: 200,
      body: [{ id: 'ts-small-stars-s2', name: 'Small Stars Series 2', file: 'b2.json' }],
    }],
    [`${DATA}/b2.json`, {
      status: 200,
      body: {
        id: 'ts-small-stars-s2',
        codeFile: 'codes-b2.json',
        figures: [{ id: 'forky', name: 'Forky' }],
      },
    }],
    [`${DATA}/codes-b2.json`, {
      status: 200,
      body: { codes: { 11: ['forky'] } },
    }],
  ]);
  const service = new DoorablesService({
    fetch: mockFetch(responses),
    syncEndpoint: SYNC,
    dataBase: DATA,
  });
  const packageInfo = resolvePackage('green backpack').packageInfo;
  const result = await service.lookup(packageInfo, 'A11', {});
  assert.equal(result.code, '11');
  assert.equal(
    lookupSpeech(result),
    'green Toy Story backpack code 11 contains Forky. Joe still needs it.');
});

test('mixed-format Ticket to Fun codes never use the Cargo Drop A recovery', () => {
  const candidates = codeDataCandidates(['811'], {
    codes: { '075': ['two-pack'], A011: ['five-pack'] },
  });
  assert.deepEqual(candidates, []);
});

test('Ticket to Fun lookups replace prior results and preserve each package count', async () => {
  const figures = Array.from({ length: 7 }, (_, index) => ({
    id: `figure-${index + 1}`,
    name: `Figure ${index + 1}`,
  }));
  const responses = new Map([
    [`${DATA}/index.json`, {
      status: 200,
      body: [{
        id: 'disney-ticket-to-fun',
        name: 'Ticket to Fun',
        file: 'ticket.json',
      }],
    }],
    [`${DATA}/ticket.json`, {
      status: 200,
      body: {
        id: 'disney-ticket-to-fun',
        codeFile: 'codes-ticket.json',
        figures,
      },
    }],
    [`${DATA}/codes-ticket.json`, {
      status: 200,
      body: {
        codes: {
          '075': ['figure-1', 'figure-2'],
          A011: ['figure-1', 'figure-2', 'figure-3', 'figure-4', 'figure-5'],
        },
      },
    }],
  ]);
  const service = new DoorablesService({
    fetch: mockFetch(responses),
    syncEndpoint: SYNC,
    dataBase: DATA,
  });
  const packageInfo = resolvePackage('ticket to fun').packageInfo;

  const malformed = await service.lookup(packageInfo, '811', {});
  assert.equal(malformed.entries.length, 0);

  const multi = await service.lookup(packageInfo, 'A11', {});
  assert.equal(multi.entries[0].variants[0].total, 5);

  const mini = await service.lookup(packageInfo, '75', {});
  assert.equal(mini.entries[0].variants[0].total, 2);
  assert.match(lookupSpeech(mini), /Figure 1 and Figure 2/);
  assert.doesNotMatch(lookupSpeech(mini), /Figure 3/);
});

test('all Alexa slot resolution candidates remain available for package lookup', async () => {
  const service = serviceWith({});
  const packageInfo = resolvePackage('gray Death Star').packageInfo;
  const result = await service.lookup(packageInfo, ['8', 'I8'], {});
  assert.equal(result.code, 'I8');
  assert.equal(result.entries[0].variants[0].names[0], 'Chopper');
});

test('red Death Star need counts use Joe\'s shared progress', async () => {
  const service = serviceWith({
    'sw-galaxy-peek-s2': {
      anakin: { have: true },
    },
  });
  const packageInfo = resolvePackage('red Death Star').packageInfo;
  const progress = await service.progress('astro-badger-delta-squid');
  const result = await service.countNeeded(packageInfo, progress);
  assert.deepEqual(result, { label: 'red Death Star', total: 3, missing: 2 });
  assert.equal(needSpeech(result), 'Joe needs 2 of the 3 red Death Star figures.');
});

test('gray Death Star I8 returns contents and how many Joe needs', async () => {
  const service = serviceWith({
    'sw-galaxy-peek-s1': {
      chopper: { have: true },
      'han-solo': { have: true },
    },
  });
  const packageInfo = resolvePackage('grey Death Star').packageInfo;
  const result = await service.lookup(packageInfo, 'i8', await service.progress(
    'astro-badger-delta-squid'));
  assert.deepEqual(result.entries[0].variants[0].names,
    ['Chopper', 'Han Solo', 'Princess Leia', 'Professor Huyang']);
  assert.equal(result.entries[0].variants[0].missing, 2);
  assert.match(lookupSpeech(result), /Joe still needs 2 of those 4 figures/);
});

test('disputed package codes preserve every reported version', async () => {
  const service = serviceWith({});
  const packageInfo = resolvePackage('red Death Star').packageInfo;
  const result = await service.lookup(packageInfo, 'A001', {});
  assert.equal(result.entries[0].disputed, true);
  const speech = lookupSpeech(result);
  assert.match(speech, /sources disagree/);
  assert.match(speech, /Clone Captain Rex/);
  assert.match(speech, /Queen Amidala/);
});

test('Queen Amidala reverse lookup returns every red Death Star code', async () => {
  const service = serviceWith({});
  const packageInfo = resolvePackage('red Death Star').packageInfo;
  const result = await service.findFigureCodes(packageInfo, 'Queen Amidala');
  assert.deepEqual(result.agreed, ['B003', 'C005']);
  assert.deepEqual(result.disputed, ['A001']);
  const speech = figureCodesSpeech(result);
  assert.match(speech, /Queen Amidala is in red Death Star codes B 003 and C 005/);
  assert.match(speech, /sources disagree about code A 001/);
});

test('a close Alexa transcription still finds a unique figure', async () => {
  const service = serviceWith({});
  const packageInfo = resolvePackage('red Death Star').packageInfo;
  const result = await service.findFigureCodes(packageInfo, 'Queen Amygdala');
  assert.equal(result.status, 'ok');
  assert.equal(result.figure, 'Queen Amidala');
});

test('spoken O batches are not silently confused with number-only codes', async () => {
  const service = serviceWith({});
  const packageInfo = resolvePackage('gray Death Star').packageInfo;

  const ambiguous = await service.lookup(packageInfo, 'oh four', {});
  assert.deepEqual(ambiguous.ambiguousCodes, ['O4', '4']);
  assert.match(lookupSpeech(ambiguous), /letter O 4, or say number 4/);

  const explicit = await service.lookup(packageInfo, 'letter O four', {});
  assert.equal(explicit.code, 'O4');
  assert.equal(explicit.entries[0].disputed, true);

  const onlyBatchMatch = await service.lookup(packageInfo, 'oh seventeen', {});
  assert.equal(onlyBatchMatch.code, 'O17');
  assert.equal(onlyBatchMatch.entries[0].variants[0].names[0], 'Han Solo');
});

test('an unknown family code is surfaced as invalid', async () => {
  const service = new DoorablesService({
    fetch: mockFetch(new Map([[SYNC, { status: 401, body: {} }]])),
    syncEndpoint: SYNC,
    dataBase: DATA,
  });
  await assert.rejects(
    service.progress('astro-badger-delta-squid'),
    (error) => error instanceof DoorablesError && error.code === 'invalid-code');
});

test('the interaction model contains the requested phrases and color follow-up', () => {
  const modelPath = path.join(
    __dirname, '..', 'alexa', 'skill-package', 'interactionModels', 'custom', 'en-US.json');
  const model = JSON.parse(fs.readFileSync(modelPath, 'utf8')).interactionModel.languageModel;
  const need = model.intents.find((intent) => intent.name === 'NeedCountIntent');
  const lookup = model.intents.find((intent) => intent.name === 'CodeLookupIntent');
  const reverse = model.intents.find((intent) => intent.name === 'FigureCodeIntent');
  const clarification = model.intents.find(
    (intent) => intent.name === 'PackageClarificationIntent');
  const codeLetters = new Set(model.types.find(
    (type) => type.name === 'CODE_LETTER').values.map(
    (entry) => entry.name.value));
  const usedCodeLetters = new Set();
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'sets'))) {
    if (!/^codes-.*\.json$/.test(file)) continue;
    const codeData = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'sets', file), 'utf8'));
    for (const section of ['codes', 'disputed']) {
      for (const code of Object.keys(codeData[section] || {})) {
        const match = code.match(/^([A-Z]+)/);
        if (match) for (const letter of match[1]) usedCodeLetters.add(letter);
      }
    }
  }
  assert.ok(need.samples.includes('how many {package} guys does Joe need'));
  assert.ok(lookup.samples.includes("what's in {package} code {capsuleCode}"));
  assert.ok(lookup.samples.includes("what's in {package} {codeLetter} {codeNumber}"));
  assert.ok(reverse.samples.includes('what code is {figure} in the {package}'));
  assert.ok(reverse.samples.includes('what codes have {figure} in the {package}'));
  assert.ok(clarification.samples.includes('{color}'));
  assert.deepEqual(
    [...usedCodeLetters].filter((letter) => !codeLetters.has(letter)),
    []);
});
