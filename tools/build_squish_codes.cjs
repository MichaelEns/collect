#!/usr/bin/env node
/**
 * Attaches capsule codes to sets whose roster came from somewhere else.
 *
 * The Squish Squadron rosters are built from the wiki's checklist, because the
 * wiki is the only place that records the colourway variants and their rarity.
 * The CODES are in the community spreadsheet — on the hand-maintained tab that
 * also holds Galaxy Peek, under Sub-Series "Squish 1" and "Squish 2".
 *
 * That tab was read for years without anyone noticing those rows: the form
 * response tab has a "Squish 1" column too, and it is completely empty, so the
 * line looked like one nobody had collected codes for. It was not. There are
 * 52 capsules recorded for Series 1 and 82 for Series 2.
 *
 * Rows here run CODE -> figures, five to a bag:
 *
 *   Name   Rarity            Series     Sub-Series  Codes
 *   A001   Squish Squadron   Star Wars  Squish 1    Chewbacca, Darth Vader, ...
 *
 * The two sources name the same figure differently. The sheet marks a variant
 * by rarity — "Luke Skywalker (SE)" — where the wiki names it by colour, as
 * "Luke Skywalker (Blue)". Rather than guess, names are resolved THROUGH the
 * roster's own rarity, and anything that cannot be resolved stops the build.
 *
 *   node tools/build_squish_codes.cjs            # fetch and build
 *   node tools/build_squish_codes.cjs sheet.csv  # build from a local copy
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const build = require('./build_codes.cjs');

const setsDir = path.join(__dirname, '..', 'sets');
const UA = 'collect-tracker/1.0 (personal collection tracker)';

/* Columns on the hand-maintained tab, shared with build_cruisers.cjs. */
const NAME_COL = 6;
const LINE_COL = 9;
const CODES_COL = 11;

const SOURCE = {
  title: 'Doorables Codes 5 : StarWars',
  credit: '@FuzzyLuzzi and the Disney Doorables collecting community',
  url: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQiHU-MXVyliejDfgndH4DG3m-rizR1wVEfgT3WUknA2eCtKyVxus-P4-PKi-bOHkbjV8SBKSiQ2P42/pubhtml?gid=1710958071&single=true',
  csv: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQiHU-MXVyliejDfgndH4DG3m-rizR1wVEfgT3WUknA2eCtKyVxus-P4-PKi-bOHkbjV8SBKSiQ2P42/pub?output=csv&gid=1710958071&single=true',
};

const SETS = [
  { sub: 'Squish 1', setId: 'sw-squish-s1', perCapsule: 5, formColumn: 'Squish 1' },
  { sub: 'Squish 2', setId: 'sw-squish-s2', perCapsule: 5, formColumn: 'Squish 2' },
];

/*
 * The same workbook's OTHER tab: one row per submission, a column per product
 * line. Both are read, because neither is a superset of the other — the
 * hand-maintained tab is curated and the form tab is raw, and a capsule
 * recorded in only one of them is still a capsule. Where they disagree the
 * code becomes disputed, which is the existing machinery for exactly this.
 */
const FORM = {
  title: 'Doorables Codes 5 : StarWars (form responses)',
  csv: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQiHU-MXVyliejDfgndH4DG3m-rizR1wVEfgT3WUknA2eCtKyVxus-P4-PKi-bOHkbjV8SBKSiQ2P42/pub?output=csv&single=true',
};

/** A code is one or more letters then digits; one digit is allowed. */
const CODE_SHAPE = /^[A-Z]{0,3}\d{1,4}$/;

/** How the sheet's bracketed suffix maps onto a roster rarity. */
const RARITY_SUFFIX = {
  se: 'special', c: 'common', r: 'rare', ur: 'ultra',
};

/**
 * Names the sheet writes differently from the roster, where the difference is
 * not a rarity marker. Listed explicitly: this is the one place a wrong guess
 * would put a real figure in the wrong capsule.
 */
const ALIAS = {
  // Wicket's full name. The roster also has a separate generic "Ewok", so a
  // looser rule here would have two plausible answers and pick one.
  'wicket w. warrick': 'wicket',
};

const CODE_NOTE = 'Every bag has a short code printed on it — a letter and some'
  + ' numbers, like A001. On the Star Wars capsules it is on the BOTTOM; a squish'
  + ' bag is a different shape and we have not confirmed where it sits, so check'
  + ' the bottom and the back. Type it in and this app will tell you which five'
  + ' squishies are inside, before you open it. The letter at the front is the'
  + ' batch, and every batch has its own codes — so if a code comes back unknown'
  + ' it is most likely from a newer batch nobody has written down yet. These'
  + ' come from collectors rather than from Just Play, who have never published'
  + ' them, so they are very good but not official.';

function fetchSheet() {
  const dest = path.join(require('os').tmpdir(), 'doorables-starwars-hand.csv');
  execFileSync('curl', ['-sSL', '--max-time', '90', '-A', UA, '-o', dest, SOURCE.csv]);
  const body = fs.readFileSync(dest, 'utf8');
  if (/^\s*<(!doctype|html)/i.test(body)) {
    throw new Error(`${SOURCE.csv} did not return a spreadsheet — has it moved?`);
  }
  return body;
}

function fetchForm() {
  const dest = path.join(require('os').tmpdir(), 'doorables-starwars-form.csv');
  execFileSync('curl', ['-sSL', '--max-time', '90', '-A', UA, '-o', dest, FORM.csv]);
  const body = fs.readFileSync(dest, 'utf8');
  if (/^\s*<(!doctype|html)/i.test(body)) {
    throw new Error(`${FORM.csv} did not return a spreadsheet — has it moved?`);
  }
  return body;
}

/** Every (code, names) pair a source offers for one set. */
function readHand(rows, spec) {
  const out = [];
  for (const row of rows) {
    if (String(row[LINE_COL] || '').trim() !== spec.sub) continue;
    const code = String(row[NAME_COL] || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!CODE_SHAPE.test(code)) continue;
    out.push({
      code,
      names: String(row[CODES_COL] || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}

function readForm(rows, spec) {
  const header = (rows[0] || []).map((c) => String(c).trim());
  const col = header.findIndex((h) => h.toLowerCase() === spec.formColumn.toLowerCase());
  const codeCol = header.findIndex((h) => /^code$/i.test(h));
  if (col < 0 || codeCol < 0) return [];
  const out = [];
  for (const row of rows.slice(1)) {
    const cell = String(row[col] || '').trim();
    if (!cell) continue;
    const code = String(row[codeCol] || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!CODE_SHAPE.test(code)) continue;
    out.push({ code, names: cell.split(',').map((s) => s.trim()).filter(Boolean) });
  }
  return out;
}

/**
 * Turns a name as the sheet writes it into a figure in this set.
 *
 * Returns null rather than a best guess. The caller stops the build on null,
 * because a figure silently dropped from a capsule makes the finder say "you
 * already have all of these" about a capsule holding one he needs.
 */
function resolve(raw, set) {
  const baseOf = (n) => n.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase();
  const wanted = ALIAS[raw.toLowerCase()] || raw.toLowerCase();

  const exact = set.figures.find((f) => f.name.toLowerCase() === wanted);
  if (exact) return exact;

  const base = baseOf(wanted);
  const candidates = set.figures.filter((f) => baseOf(f.name) === base);
  if (!candidates.length) return null;

  const suffix = (wanted.match(/\(([^)]*)\)\s*$/) || [])[1];
  if (suffix) {
    const rarity = RARITY_SUFFIX[suffix.trim().toLowerCase()];
    const byRarity = candidates.filter((f) => f.rarity === rarity);
    return byRarity.length === 1 ? byRarity[0] : null;
  }

  // A bare name against a roster that qualifies it. Safe only when one figure
  // is left: "Chopper" -> "Chopper (C1-10P)" when that is the only Chopper.
  if (candidates.length === 1) return candidates[0];
  const plain = candidates.filter((f) => f.rarity !== 'special');
  return plain.length === 1 ? plain[0] : null;
}

function buildSet(spec, entries) {
  const setFile = path.join(setsDir, `${spec.setId}.json`);
  const set = JSON.parse(fs.readFileSync(setFile, 'utf8'));

  const byCode = new Map();
  const spellings = new Map();
  const rejected = [];
  const unresolved = new Map();

  for (const { code, names } of entries) {
    if (names.length !== spec.perCapsule) {
      rejected.push(`${code} names ${names.length}, expected ${spec.perCapsule}: ${names.join(', ')}`);
      continue;
    }

    const ids = [];
    for (const name of names) {
      const figure = resolve(name, set);
      if (!figure) { unresolved.set(name, (unresolved.get(name) || 0) + 1); continue; }
      ids.push(figure.id);
    }
    if (ids.length !== names.length) continue;

    ids.sort();
    const key = build.codeKey(code);
    if (!byCode.has(key)) { byCode.set(key, new Map()); spellings.set(key, new Map()); }
    byCode.get(key).set(ids.join('|'), ids);
    const tally = spellings.get(key);
    tally.set(code, (tally.get(code) || 0) + 1);
  }

  if (unresolved.size) {
    throw new Error(`${spec.setId}: these names in the sheet match no figure in the roster:\n`
      + [...unresolved].map(([n, c]) => `   "${n}" (${c} time(s))`).join('\n')
      + '\n\nAdd them to ALIAS in this file once you have checked which figure they mean.');
  }

  const shown = new Map();
  for (const [key, tally] of spellings) {
    shown.set(key, [...tally].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0]);
  }

  const agreed = {};
  const disputed = {};
  for (const [key, variants] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
    const code = shown.get(key);
    if (variants.size === 1) agreed[code] = [...variants.values()][0];
    else disputed[code] = [...variants.values()];
  }

  const batches = {};
  for (const code of Object.keys(agreed)) {
    const letter = (code.match(/^[A-Z]+/) || ['#'])[0];
    batches[letter] = (batches[letter] || 0) + 1;
  }

  fs.writeFileSync(
    path.join(setsDir, `codes-${spec.setId}.json`),
    `${JSON.stringify({
      setId: spec.setId,
      source: { ...SOURCE, retrieved: new Date().toISOString().slice(0, 10) },
      alsoFrom: FORM.title,
      batches,
      codes: agreed,
      disputed,
    }, null, 1)}\n`,
  );

  // The set no longer needs to apologise for having no codes.
  delete set.countNote;
  set.figuresPerCapsule = spec.perCapsule;
  set.codeFile = `codes-${spec.setId}.json`;
  set.codeNote = CODE_NOTE;
  fs.writeFileSync(setFile, `${JSON.stringify(set, null, 1)}\n`);

  const covered = new Set(Object.values(agreed).flat());
  console.log(`${spec.setId}: ${Object.keys(agreed).length} codes, `
    + `${Object.keys(disputed).length} disputed, ${covered.size}/${set.figures.length} figures covered`);
  if (rejected.length) {
    console.log(`  ${rejected.length} row(s) ignored, wrong number of figures:`);
    for (const r of rejected) console.log(`     ${r}`);
  }
  const missing = set.figures.filter((f) => !covered.has(f.id));
  if (missing.length) {
    console.log(`  ${missing.length} figure(s) in no recorded capsule: ${missing.map((f) => f.name).join(', ')}`);
  }
}

function main() {
  const local = process.argv[2];
  const hand = build.parseCsv(local ? fs.readFileSync(local, 'utf8') : fetchSheet());
  const form = local ? [] : build.parseCsv(fetchForm());
  for (const spec of SETS) {
    const fromHand = readHand(hand, spec);
    const fromForm = form.length ? readForm(form, spec) : [];
    console.log(`${spec.setId}: ${fromHand.length} row(s) hand-maintained, `
      + `${fromForm.length} submitted`);
    buildSet(spec, fromHand.concat(fromForm));
  }
}

main();
