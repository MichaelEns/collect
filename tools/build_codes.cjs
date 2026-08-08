#!/usr/bin/env node
/**
 * Builds the Galaxy Peek roster and capsule-code files from the community
 * spreadsheet.
 *
 * The sheet is not re-hosted here. It is other people's work, and the app only
 * needs the facts out of it — which figure is in which capsule — so the tool
 * takes a freshly downloaded copy and writes only what the app uses.
 *
 *   curl -L -o codes.csv "https://docs.google.com/spreadsheets/d/e/2PACX-1vQiHU-cMlB9x1cjW3EGZUMDsx-7lryPflBjSGkZTVaOFvNlfPzHnEmWLGDeJXPHVdmKQyD3DFxo1S9U/pub?gid=1710958071&single=true&output=csv"
 *   node tools/build_codes.cjs codes.csv
 *
 * What the sheet holds, and where:
 *   - Five checklist blocks of exactly 25 rows each, at columns 21-23
 *     (name / rarity / bag number), running Series 1 through 5 in order.
 *   - Capsule rows anywhere below, recognised by a cell reading "Galaxy".
 *     Relative to that cell: -3 is the bag barcode, -1 the capsule code,
 *     +2 the series number, +4 the four figures inside.
 *
 * Nothing is guessed. A name that cannot be matched to a roster is a hard
 * error, because silently dropping a figure would leave a child with a
 * checklist that can never be completed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/*
 * Where the codes come from.
 *
 * The first sheet this app was built on was withdrawn and now 404s — which is
 * why tools/scan_sources.cjs exists, and why `csv` is recorded separately from
 * the human-facing `url`: a machine needs the export, a person needs the page.
 * The replacement was found linked from the wiki's Series 1, 2 and 5 pages and
 * confirmed by parsing it: it reproduces the shipped rosters and every shipped
 * code exactly, which is what makes it the same sheet rather than a lookalike.
 */
const SOURCE = {
  title: 'Doorables Codes 5 : StarWars',
  credit: '@FuzzyLuzzi and the Disney Doorables collecting community',
  url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQiHU-MXVyliejDfgndH4DG3m-rizR1wVEfgT3WUknA2eCtKyVxus-P4-PKi-bOHkbjV8SBKSiQ2P42/pubhtml?gid=1710958071&single=true',
  csv: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQiHU-MXVyliejDfgndH4DG3m-rizR1wVEfgT3WUknA2eCtKyVxus-P4-PKi-bOHkbjV8SBKSiQ2P42/pub?output=csv&gid=1710958071&single=true',
  via: 'https://disney-doorables.fandom.com/wiki/Star_Wars_Galaxy_Peek_Series_2',
};

/**
 * How many series the sheet is expected to hold, and where its blocks sit.
 *
 * These are the numbers that would go wrong first if the sheet gained a
 * Series 6 or changed shape, so tools/scan_sources.cjs reads them from here
 * rather than keeping its own copy that could drift.
 */
const SERIES_COUNT = 5;
const FIRST_BLOCK_ROW = 3;
const BLOCK_SIZE = 25;
const NAME_COL = 21;
const RARITY_COL = 22;
const BAG_COL = 23;

const RARITIES = {
  Common: 'common',
  Rare: 'rare',
  'Ultra Rare': 'ultra',
  'Special Edition': 'special',
};

/** Sheet spelling -> the name the app shows. Only where they differ. */
const RENAME = {
  Huyang: 'Professor Huyang',
  'Hologram Leia': 'Princess Leia (hologram)',
  Chopper: 'Chopper (C1-10P)',
  'Anakin (Kid)': 'Anakin Skywalker (young)',
  'Anakin (Teen)': 'Anakin Skywalker (Padawan)',
  'Yoda (C)': 'Yoda',
  'Yoda (R)': 'Yoda (rare version)',
  'Garazeb ZEB Orrelios': 'Garazeb "Zeb" Orrelios',
  'Sabine Wren (C)': 'Sabine Wren',
};

/** Bag numbers the sheet leaves blank, recovered from the printed checklist. */
const KNOWN_BAGS = {
  1: { 'Ahsoka Tano': 20, 'Chopper (C1-10P)': 25, 'Han Solo': 16, 'Professor Huyang': 12, 'R2-D2': 4 },
};

function parseCsv(input) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const cell = (rows, y, x) => ((rows[y] || [])[x] || '').trim();

/** Stable, readable, and safe to put in a URL or a DOM id. */
function slug(name) {
  return name.toLowerCase()
    .replace(/["'.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Ids already in use are kept. A child's ticks are stored against them in the
 * browser, so a "tidier" id would silently wipe a collection.
 */
function existingIds(setId) {
  const file = path.join(__dirname, '..', 'sets', `${setId}.json`);
  if (!fs.existsSync(file)) return new Map();
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(set.figures.map((f) => [f.name, f.id]));
}

function readRosters(rows) {
  const rosters = {};
  for (let s = 1; s <= SERIES_COUNT; s += 1) {
    const keep = existingIds(`sw-galaxy-peek-s${s}`);
    const start = FIRST_BLOCK_ROW + (s - 1) * BLOCK_SIZE;
    const figures = [];
    for (let i = 0; i < BLOCK_SIZE; i += 1) {
      const y = start + i;
      const raw = cell(rows, y, NAME_COL);
      const rarityWord = cell(rows, y, RARITY_COL);
      if (!raw) throw new Error(`series ${s}: row ${y} has no name — the block layout has shifted`);
      if (!(rarityWord in RARITIES)) {
        throw new Error(`series ${s}: row ${y} (${raw}) has unknown rarity ${JSON.stringify(rarityWord)}`);
      }
      const name = RENAME[raw] || raw;
      const bagRaw = cell(rows, y, BAG_COL);
      const bag = bagRaw ? parseInt(bagRaw, 10) : (KNOWN_BAGS[s] || {})[name] || null;
      figures.push({ id: keep.get(name) || slug(name), sheetName: raw, name, rarity: RARITIES[rarityWord], bag });
    }
    const ids = new Set(figures.map((f) => f.id));
    if (ids.size !== BLOCK_SIZE) throw new Error(`series ${s}: duplicate figure id`);
    rosters[s] = figures;
  }
  return rosters;
}

function readCodes(rows, rosters) {
  const out = {};
  for (let s = 1; s <= SERIES_COUNT; s += 1) out[s] = { codes: new Map(), skipped: 0 };

  for (const r of rows) {
    const g = r.findIndex((c) => c.trim() === 'Galaxy');
    if (g < 1) continue;
    const series = (r[g + 2] || '').trim();
    if (!out[series]) continue;
    const code = (r[g - 1] || '').trim().toUpperCase().replace(/\s+/g, '');
    const names = (r[g + 4] || '').split(',').map((t) => t.trim()).filter(Boolean);
    // A capsule holds exactly four. Anything else is a summary row or an
    // incomplete entry, and guessing at it would invent data.
    if (!code || names.length !== 4) { out[series].skipped += 1; continue; }

    const byName = new Map(rosters[series].map((f) => [f.sheetName, f.id]));
    const ids = [];
    for (const n of names) {
      const id = byName.get(n);
      if (!id) throw new Error(`series ${s === undefined ? series : series}: code ${code} names "${n}", which is not in that roster`);
      ids.push(id);
    }
    ids.sort();
    const key = ids.join('|');
    if (!out[series].codes.has(code)) out[series].codes.set(code, new Map());
    out[series].codes.get(code).set(key, ids);
  }
  return out;
}

function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('usage: node tools/build_codes.cjs <path-to-codes.csv>');
    process.exit(2);
  }
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
  const rosters = readRosters(rows);
  const codes = readCodes(rows, rosters);
  const outDir = path.join(__dirname, '..', 'sets');
  const retrieved = new Date().toISOString().slice(0, 10);

  for (let s = 1; s <= SERIES_COUNT; s += 1) {
    const setId = `sw-galaxy-peek-s${s}`;
    const agreed = {};
    const disputed = {};
    for (const [code, variants] of [...codes[s].codes].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (variants.size === 1) agreed[code] = [...variants.values()][0];
      else disputed[code] = [...variants.values()];
    }

    const batches = {};
    for (const code of Object.keys(agreed)) {
      const letter = (code.match(/^[A-Z]+/) || ['#'])[0];
      batches[letter] = (batches[letter] || 0) + 1;
    }

    fs.writeFileSync(
      path.join(outDir, `codes-${setId}.json`),
      `${JSON.stringify({ setId, source: { ...SOURCE, retrieved }, batches, codes: agreed, disputed }, null, 1)}\n`,
    );

    const covered = new Set(Object.values(agreed).flat());
    console.log(
      `series ${s}: ${Object.keys(agreed).length} codes, ${Object.keys(disputed).length} disputed, `
      + `${codes[s].skipped} skipped rows, ${covered.size}/25 figures covered, `
      + `batches ${Object.entries(batches).map(([l, n]) => `${l}=${n}`).join(' ')}`,
    );
    const missingBags = rosters[s].filter((f) => !f.bag).map((f) => f.name);
    if (missingBags.length) console.log(`  no bag number: ${missingBags.join(', ')}`);
  }

  fs.writeFileSync(
    path.join(__dirname, 'rosters.generated.json'),
    `${JSON.stringify(rosters, null, 1)}\n`,
  );
  console.log('\nrosters written to tools/rosters.generated.json for review');
}

/*
 * Run as a tool, or be read as one. tools/scan_sources.cjs imports the parser
 * and the layout constants so that a scan and a build can never disagree about
 * what the sheet says — a scan that reported on its own private copy of these
 * rules would be checking something the app does not use.
 */
if (require.main === module) main();

module.exports = {
  SOURCE,
  SERIES_COUNT,
  FIRST_BLOCK_ROW,
  BLOCK_SIZE,
  NAME_COL,
  RARITY_COL,
  BAG_COL,
  RARITIES,
  RENAME,
  parseCsv,
  cell,
  slug,
  readRosters,
  readCodes,
};
