#!/usr/bin/env node
/**
 * Builds the Galactic Cruisers sets from the community spreadsheet.
 *
 * Separate from build_sets.cjs because Cruisers is a different product, not a
 * sixth Galaxy Peek series, and the two differ in ways that matter:
 *
 *   - A Galaxy Peek capsule holds FOUR figures. A Cruisers pack holds ONE
 *     figure and one vehicle, so a code names one figure, not four. The sets
 *     carry figuresPerCapsule so nothing has to assume.
 *   - The sheet stores Cruisers codes the other way round: per figure, as a
 *     list of every code that figure appears in. They are inverted here.
 *   - Ten figures per series rather than twenty-five.
 *
 * Reusing figure ids across sets is safe and already happens — Luke Skywalker
 * appears in four Galaxy Peek series. Progress is keyed by SET first
 * (collect.progress.<setId>), so the same id in two sets is two separate
 * records and nothing can bleed between them.
 *
 *   curl -L -o codes.csv "<the csv url in tools/build_codes.cjs>"
 *   node tools/build_cruisers.cjs codes.csv
 */
'use strict';

const fs = require('fs');
const path = require('path');
const build = require('./build_codes.cjs');

const setsDir = path.join(__dirname, '..', 'sets');

/** Where the Cruisers block sits in the sheet. */
const NAME_COL = 6;
const RARITY_COL = 7;
const LINE_COL = 9;
const CODES_COL = 11;

/** Sheet line name -> our set id and series number. */
const LINES = {
  Cruisers: 1,
  'Cruisers 2': 2,
  'Cruisers 3': 3,
};

const RARITIES = build.RARITIES;

const META = {
  1: {
    released: '2024',
    theme: 'The heroes everyone knows, each with a ship',
  },
  2: {
    released: '2025',
    theme: 'The sequel trilogy and the bounty hunters',
  },
  3: {
    released: '2026',
    theme: 'Ahsoka, Rogue One and the prequels',
    codeNote: null,
  },
};

const RARITY_DEFS = [
  { id: 'common', label: 'Common', colour: '#8fa3d9' },
  { id: 'rare', label: 'Rare', colour: '#7ee8ff' },
  { id: 'ultra', label: 'Ultra Rare', colour: '#ffc93d' },
  { id: 'special', label: 'Special Edition', colour: '#ff7ad9' },
];

const PACKAGING = 'Cruiser pack — one figure and one ship';

const PACKAGING_NOTE = 'This is not a Galaxy Peek capsule. A Cruisers pack holds'
  + ' ONE figure and the ship that goes with it, so a code tells you about one'
  + ' figure rather than four.';

const CODE_NOTE = 'Every pack has a short code — a letter and some numbers, like'
  + ' A010. On the Galaxy Peek capsules it is pressed into the plastic on the'
  + ' BOTTOM; we have not confirmed where it sits on a Cruisers pack, so check'
  + ' the bottom and the back. Type it into the box at the top and this app will'
  + ' tell you which figure is inside, before you open it. The letter at the'
  + ' front is the batch, and every batch has its own codes — so if a code comes'
  + ' back unknown it is most likely from a newer batch nobody has written down'
  + ' yet. These come from collectors rather than from Just Play, who have never'
  + ' published them, so they are very good but not official.';

const SOURCED = 'Ten figures, from the same community spreadsheet as the Galaxy'
  + ' Peek codes. Just Play has not published a checklist for this line, so'
  + ' treat it as very good community data rather than gospel.';

/*
 * What a Cruisers code looks like: one to three letters then digits, e.g.
 * A010, MO019, KO010.
 *
 * The shape has to be checked because several of the sheet's per-figure lists
 * begin with a stray number — Luke Skywalker's starts "5187", Grogu's starts
 * "0" — which are row ids or counts that have leaked into the cell. Taken at
 * face value they became codes, and the app would have confidently answered
 * "5187 contains Luke Skywalker" to a code that does not exist.
 */
const CODE_SHAPE = /^[A-Z]{1,3}\d{2,4}$/;

/** Ids already in use are kept, so a rebuild never orphans a child's ticks. */
function existingIds(setId) {
  const file = path.join(setsDir, `${setId}.json`);
  if (!fs.existsSync(file)) return new Map();
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(set.figures.map((f) => [f.name, f.id]));
}

function read(rows) {
  const lines = new Map();
  const rejected = new Map();
  for (const row of rows) {
    const line = String(row[LINE_COL] || '').trim();
    if (!(line in LINES)) continue;
    const name = String(row[NAME_COL] || '').trim();
    if (!name) continue;
    const rarityWord = String(row[RARITY_COL] || '').trim();
    const raw = String(row[CODES_COL] || '')
      .split(',').map((c) => c.trim().toUpperCase().replace(/\s+/g, '')).filter(Boolean);
    const codes = raw.filter((c) => CODE_SHAPE.test(c));
    for (const c of raw) {
      if (!CODE_SHAPE.test(c)) rejected.set(c, (rejected.get(c) || 0) + 1);
    }
    if (!lines.has(line)) lines.set(line, []);
    lines.get(line).push({ name, rarityWord, codes });
  }
  if (rejected.size) {
    // Printed, not swallowed. These are the values that would otherwise have
    // been invented as codes, and a silent filter is how they got in.
    console.log(`ignored ${rejected.size} value(s) that are not codes: `
      + [...rejected].map(([v, n]) => `${v}${n > 1 ? ` x${n}` : ''}`).join(', '));
  }
  return lines;
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('usage: node tools/build_cruisers.cjs <path-to-codes.csv>');
    process.exit(2);
  }
  const rows = build.parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const lines = read(rows);
  const retrieved = new Date().toISOString().slice(0, 10);

  for (const [lineName, series] of Object.entries(LINES)) {
    const figures = lines.get(lineName);
    if (!figures || !figures.length) {
      console.log(`${lineName}: nothing in the sheet, skipped`);
      continue;
    }
    const setId = `sw-cruisers-s${series}`;
    const keep = existingIds(setId);

    const roster = figures.map((f) => {
      // The same sheet spellings appear here as in Galaxy Peek — "Sabine Wren
      // (C)" where the (C) means common, "Chopper" for the droid whose full
      // name is Chopper (C1-10P) — so the same corrections apply. Sharing the
      // map rather than copying it means a fix in one place fixes both.
      const name = build.RENAME[f.name] || f.name;
      const entry = { id: keep.get(name) || build.slug(name), name };
      if (RARITIES[f.rarityWord]) entry.rarity = RARITIES[f.rarityWord];
      else entry.rarityUnknown = true;
      return entry;
    }).sort((a, b) => a.name.localeCompare(b.name));

    const ids = new Set(roster.map((f) => f.id));
    if (ids.size !== roster.length) throw new Error(`${setId}: duplicate figure id`);

    // Invert "figure -> its codes" into "code -> its figure". A code claimed by
    // more than one figure is a disagreement, not a bigger pack, so it goes
    // down the disputed path rather than being merged into a pair.
    const byCode = new Map();
    const byName = new Map(figures.map((f, i) => [f.name, roster.find((r) => r.name === f.name) || roster[i]]));
    for (const f of figures) {
      for (const code of f.codes) {
        if (!byCode.has(code)) byCode.set(code, new Set());
        byCode.get(code).add(byName.get(f.name).id);
      }
    }

    const agreed = {};
    const disputed = {};
    for (const [code, set] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
      const list = [...set].sort();
      if (list.length === 1) agreed[code] = list;
      else disputed[code] = list.map((id) => [id]);
    }

    const batches = {};
    for (const code of Object.keys(agreed)) {
      const letter = (code.match(/^[A-Z]+/) || ['#'])[0];
      batches[letter] = (batches[letter] || 0) + 1;
    }

    const meta = META[series] || {};
    const set = {
      id: setId,
      brand: 'Star Wars Doorables',
      name: `Galactic Cruisers Series ${series}`,
      packaging: PACKAGING,
      packagingNote: PACKAGING_NOTE,
      emoji: '🚀',
      official: 'https://justplayproducts.com/collections/star-wars-doorables/',
      released: meta.released,
      figuresPerCapsule: 1,
      verified: false,
      sourced: SOURCED,
      rarities: RARITY_DEFS.filter((r) => roster.some((f) => f.rarity === r.id)),
      figures: roster,
    };

    if (roster.some((f) => f.rarityUnknown)) {
      set.rarityNote = 'Some rarities are not recorded yet, and are left blank'
        + ' rather than guessed at.';
    }

    /*
     * The wiki page is worth linking whether or not there are codes yet: it is
     * the only route from the app to a picture of the figure being hunted. An
     * earlier version set this only alongside a code file, so Series 3 — the
     * one with no codes recorded — was the one series offering no way through
     * to see what its figures look like.
     */
    set.codeLink = `https://disney-doorables.fandom.com/wiki/Galactic_Cruisers_Series_${series}`;
    set.codeLinkLabel = `Galactic Cruisers Series ${series} on the Doorables wiki`;

    if (Object.keys(agreed).length) {
      set.codeFile = `codes-${setId}.json`;
      set.codeNote = CODE_NOTE;
      fs.writeFileSync(
        path.join(setsDir, `codes-${setId}.json`),
        `${JSON.stringify({
          setId, source: { ...build.SOURCE, retrieved }, batches, codes: agreed, disputed,
        }, null, 1)}\n`,
      );
    } else {
      // Said on screen rather than left as an empty finder, which would look
      // like the app failing to answer.
      set.countNote = 'No pack codes have been recorded for this series yet, so'
        + ' there is nothing to look up — only the checklist.';
    }

    fs.writeFileSync(path.join(setsDir, `${setId}.json`), `${JSON.stringify(set, null, 1)}\n`);

    const covered = new Set(Object.values(agreed).flat());
    console.log(`${setId}: ${roster.length} figures, ${Object.keys(agreed).length} codes, `
      + `${Object.keys(disputed).length} disputed, ${covered.size}/${roster.length} figures covered`
      + (set.rarityNote ? ', some rarities unknown' : ''));
  }
}

main();
