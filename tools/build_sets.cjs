#!/usr/bin/env node
/**
 * Writes the Galaxy Peek set files from tools/rosters.generated.json.
 *
 * Series 1 and 2 already existed and were hand-checked, so their descriptive
 * metadata is preserved verbatim and only the figure list is regenerated —
 * which the diff proved is identical anyway. Series 3, 4 and 5 are new.
 *
 *   node tools/build_codes.cjs codes.csv && node tools/build_sets.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

const rostersFile = path.join(__dirname, 'rosters.generated.json');
if (!fs.existsSync(rostersFile)) {
  console.error('tools/rosters.generated.json is missing.\n'
    + 'It is build output, not checked in. Run tools/build_codes.cjs first:\n'
    + '  node tools/build_codes.cjs <path-to-codes.csv>');
  process.exit(2);
}
const rosters = require('./rosters.generated.json');
const setsDir = path.join(__dirname, '..', 'sets');

const RARITIES = [
  { id: 'common', label: 'Common', colour: '#8fa3d9' },
  { id: 'rare', label: 'Rare', colour: '#7ee8ff' },
  { id: 'ultra', label: 'Ultra Rare', colour: '#ffc93d' },
  { id: 'special', label: 'Special Edition', colour: '#ff8ad8' },
];

const SOURCED = 'Roster, rarity and bag numbers come from the community code'
  + ' spreadsheet kept by @FuzzyLuzzi and the Doorables collectors, which lists'
  + ' 25 figures for this series. For Series 1 and 2 that sheet agreed with the'
  + ' Doorables wiki, HobbyDB and Coleka on every single figure, which is why'
  + ' the later series are trusted too — but Just Play has never published an'
  + ' official checklist, so this is very good community data rather than gospel.';

const CODE_NOTE = 'Every capsule has a short code pressed into the plastic on'
  + ' the BOTTOM — a letter and some numbers, like A001. It is moulded rather'
  + ' than printed, so tilt it to the light or feel for it with a fingernail.'
  + ' Type it into the box at the top and this app will tell you which four'
  + ' figures are inside, before you open it. The letter at the front is the'
  + ' batch, and every batch has its own codes — so if a code comes back'
  + ' unknown it is most likely from a newer batch nobody has written down'
  + ' yet. These come from collectors rather than from Just Play, who have'
  + ' never published them, so they are very good but not official.';

/**
 * Descriptions a child can act on.
 *
 * The capsule is how he tells them apart on a shelf, so it is the one field
 * worth getting right. It is NOT a Death Star throughout: Just Play changed
 * the moulding after Series 2, which an earlier draft of this file got wrong.
 * Where the colour could not be confirmed it is left unstated rather than
 * guessed, and the set carries a note saying to check the printed number.
 */
const META = {
  1: {
    packaging: 'Blue Death Star capsule',
    itemNumber: '44822',
    upc: '886144448225',
    released: '2024-02',
    theme: 'The heroes and villains everyone knows',
  },
  2: {
    packaging: 'Red Death Star capsule',
    itemNumber: '44896',
    upc: '886144448966',
    released: '2024-09-17',
    theme: 'Clones, prequels and the First Order',
  },
  3: {
    packaging: 'Cargo-drop capsule',
    packagingNote: 'From Series 3 the capsule stopped being a Death Star. This'
      + ' one is a cargo drop that opens out into a display. We could not'
      + ' confirm its colour, so check the series number printed on the packet.',
    itemNumber: '44992',
    upc: '886144449925',
    released: '2025-02',
    theme: 'Jedi of the High Republic, and the crew of Rogue One',
  },
  4: {
    packaging: 'Cargo-drop capsule, opens into a two-level display',
    packagingNote: 'We could not confirm this capsule\'s colour, so check the'
      + ' series number printed on the packet.',
    itemNumber: '50033',
    upc: '886144500336',
    released: '2025-10-21',
    theme: 'Droids, and the crew of the Ghost',
    countNote: 'Just Play\'s own description of Series 4 mentions 50 figures'
      + ' while shops list 25, so there may be a second wave we do not have.'
      + ' These 25 are the ones collectors have recorded codes for.',
  },
  5: {
    packaging: 'Grey AT-AT capsule',
    packagingNote: 'This one is an AT-AT walker rather than a Death Star, and'
      + ' it opens out into a diorama.',
    itemNumber: '50111',
    upc: '886144501111',
    released: '2026-07',
    theme: 'Bounty hunters, and the creatures of the galaxy',
    rarityNote: 'Just Play had not published the rarity sheet for Series 5 when'
      + ' this was made, and collectors do not all agree on it. The rare ones'
      + ' here come from the same community list as the codes.',
  },
};

const EMOJI = { 1: '🔵', 2: '🔴', 3: '⭐', 4: '🤖', 5: '🪐' };

function build(series) {
  const setId = `sw-galaxy-peek-s${series}`;
  const file = path.join(setsDir, `${setId}.json`);
  const roster = rosters[series];

  // Sort by the number printed on the paper checklist, so the app lists them
  // in the same order as the sheet in the child's hand.
  const figures = roster.slice().sort((a, b) => (a.bag || 99) - (b.bag || 99)).map((f) => {
    const fig = { id: f.id, name: f.name, rarity: f.rarity };
    if (f.bag) fig.number = String(f.bag).padStart(2, '0');
    else fig.numberUnknown = true;
    return fig;
  });

  const m = META[series];
  let set;
  if (fs.existsSync(file)) {
    // Keep every hand-written field; refresh only what we now know better.
    set = JSON.parse(fs.readFileSync(file, 'utf8'));
    const notes = new Map(set.figures.map((f) => [f.id, f.note]));
    const verified = new Map(set.figures.map((f) => [f.id, f.verified]));
    set.figures = figures.map((f) => {
      const out = { ...f };
      if (notes.get(f.id)) out.note = notes.get(f.id);
      if (verified.get(f.id) !== undefined) out.verified = verified.get(f.id);
      return out;
    });
  } else {
    set = {
      id: setId,
      brand: 'Star Wars Doorables',
      name: `Galaxy Peek Series ${series}`,
      emoji: EMOJI[series],
      official: 'https://justplayproducts.com/collections/star-wars-doorables/',
      figuresPerCapsule: 4,
      verified: false,
      sourced: SOURCED,
      numberLabel: 'Bag #',
      numberNote: 'The number printed beside each figure on the paper checklist inside the capsule.',
      figures,
    };
  }

  // The capsule, the item number and the date are what identify the right box
  // in a shop, so they are refreshed from META rather than left as first drafts.
  set.packaging = m.packaging;
  set.theme = m.theme;
  set.itemNumber = m.itemNumber;
  set.upc = m.upc;
  set.released = m.released;
  set.emoji = EMOJI[series];
  for (const key of ['packagingNote', 'countNote', 'rarityNote']) {
    if (m[key]) set[key] = m[key];
    else delete set[key];
  }

  set.rarities = RARITIES.filter((r) => figures.some((f) => f.rarity === r.id));
  set.codeNote = CODE_NOTE;
  set.codeFile = `codes-${setId}.json`;
  set.codeLink = 'https://disney-doorables.fandom.com/wiki/Star_Wars_Galaxy_Peek_Series_2';
  set.codeLinkLabel = 'Community code spreadsheet (via the Doorables wiki)';

  fs.writeFileSync(file, `${JSON.stringify(set, null, 1)}\n`);
  const tally = {};
  for (const f of figures) tally[f.rarity] = (tally[f.rarity] || 0) + 1;
  console.log(`${setId}: ${figures.length} figures  ${JSON.stringify(tally)}`);
}

for (let s = 1; s <= 5; s += 1) build(s);

// The index the app reads to offer the sets, in series order.
const index = [1, 2, 3, 4, 5].map((s) => {
  const set = JSON.parse(fs.readFileSync(path.join(setsDir, `sw-galaxy-peek-s${s}.json`), 'utf8'));
  return {
    id: set.id,
    file: `${set.id}.json`,
    name: set.name,
    brand: set.brand,
    packaging: set.packaging,
    emoji: set.emoji,
    total: set.figures.length,
  };
});
fs.writeFileSync(path.join(setsDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`index.json: ${index.length} sets`);
