#!/usr/bin/env node
/**
 * Builds sets from the community's *form-response* sheets.
 *
 * The Star Wars codes live in a hand-maintained sheet (see build_codes.cjs).
 * The rest of the Doorables range is recorded differently: a Google Form that
 * collectors submit codes to, one row per submission, with a column per
 * product line holding the figures in that capsule. Six such sheets are linked
 * from the wiki; five are reachable.
 *
 * Shape of a row:
 *
 *   Timestamp | Series | Code | ... | Toy Story                | ...
 *   7/7/2026  | ReRel. | A011 | ... | Bullseye, Buzz, Jessie   | ...
 *
 * So a set is a (sheet, column) pair, and this is config-driven rather than
 * one tool per set — the columns genuinely share a structure, and fourteen
 * more of them are buildable on the same terms.
 *
 * What it will NOT do is build a column whose codes disagree about how many
 * figures a capsule holds. Those columns exist — the mainline series are only
 * 40-70% consistent, because submissions there are often partial — and a
 * finder built on a partial record answers confidently and wrongly, which is
 * the one failure this app exists to avoid.
 *
 *   node tools/build_community_sets.cjs            # fetch and build
 *   node tools/build_community_sets.cjs sheet.csv  # build from a local copy
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const build = require('./build_codes.cjs');

const setsDir = path.join(__dirname, '..', 'sets');

const UA = 'collect-tracker/1.0 (personal collection tracker)';

/**
 * The sheets, by the short name used below.
 *
 * `csv` is the machine-readable export and `url` the page a person should
 * open — recorded separately for the same reason as in build_codes.cjs.
 */
const SHEETS = {
  holiday: {
    id: '2PACX-1vTKKIoEPPo4cpdp4uBOzwfMMKDFCspT3x5HJDchW9uC1qL1wI1oKRZfWsRvFif8WM2RVBThaRqsWrrH',
    title: 'Doorables Codes : Costume, Holiday and Re-releases',
    credit: 'the Disney Doorables collecting community',
  },
};

for (const s of Object.values(SHEETS)) {
  s.url = `https://docs.google.com/spreadsheets/d/e/${s.id}/pubhtml`;
  s.csv = `https://docs.google.com/spreadsheets/d/e/${s.id}/pub?output=csv&single=true`;
}

/**
 * The sets to build.
 *
 * `perCapsule` is asserted rather than inferred: it is the number this set's
 * codes must consistently name, and a sheet that stops agreeing with it should
 * stop the build rather than quietly ship a mixture.
 */
const SETS = [
  {
    id: 'ts-rerelease',
    sheet: 'holiday',
    column: 'Toy Story',
    name: 'Toy Story',
    brand: 'Disney Doorables',
    emoji: '🤠',
    perCapsule: 3,
    packaging: 'Blind bag, three figures inside',
    packagingNote: 'This is a Disney Doorables bag rather than a Star Wars'
      + ' capsule, and it holds THREE figures rather than four.',
    official: 'https://justplayproducts.com/collections/disney-doorables/',
    sourced: '15 figures, from the community code sheet that collectors submit'
      + ' to. Just Play has not published a checklist for this line, so treat it'
      + ' as very good community data rather than gospel.',
    rarityNote: 'Nobody has recorded which of these are rare, so this set shows'
      + ' no rarity colours rather than guessing at them.',
    wiki: 'https://disney-doorables.fandom.com/wiki/Toy_Story',
    wikiLabel: 'Toy Story characters on the Doorables wiki',
  },
];

/** A code is one or more letters then digits. */
const CODE_SHAPE = /^[A-Z]{1,3}\d{2,4}$/;

const CODE_NOTE = 'Every bag has a short code printed on it — a letter and some'
  + ' numbers, like A011. On the Star Wars capsules it is on the BOTTOM; we have'
  + ' not confirmed where it sits on a Doorables bag, so check the bottom and the'
  + ' back. Type it into the box at the top and this app will tell you which'
  + ' figures are inside, before you open it. The letter at the front is the'
  + ' batch, and every batch has its own codes — so if a code comes back unknown'
  + ' it is most likely from a newer batch nobody has written down yet. These'
  + ' come from collectors rather than from Just Play, who have never published'
  + ' them, so they are very good but not official.';

/** Ids already in use are kept, so a rebuild never orphans a child's ticks. */
function existingIds(setId) {
  const file = path.join(setsDir, `${setId}.json`);
  if (!fs.existsSync(file)) return new Map();
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(set.figures.map((f) => [f.name, f.id]));
}

function fetchSheet(sheet) {
  const dest = path.join(require('os').tmpdir(), `doorables-${sheet.id.slice(0, 10)}.csv`);
  execFileSync('curl', ['-sSL', '--max-time', '60', '-A', UA, '-o', dest, sheet.csv]);
  const body = fs.readFileSync(dest, 'utf8');
  if (/^\s*<(!doctype|html)/i.test(body)) {
    throw new Error(`${sheet.csv} did not return a spreadsheet — has it moved?`);
  }
  return body;
}

function buildSet(spec, csv) {
  const rows = build.parseCsv(csv);
  const header = (rows[0] || []).map((c) => String(c).trim());
  const col = header.findIndex((h) => h.toLowerCase() === spec.column.toLowerCase());
  if (col < 0) throw new Error(`the sheet has no "${spec.column}" column any more`);
  const codeCol = header.findIndex((h) => /^code$/i.test(h));
  if (codeCol < 0) throw new Error('the sheet has no "Code" column any more');

  const keep = existingIds(spec.id);
  const byCode = new Map();
  const roster = new Map();
  const rejected = [];

  for (const row of rows.slice(1)) {
    const cell = String(row[col] || '').trim();
    if (!cell) continue;
    const code = String(row[codeCol] || '').trim().toUpperCase().replace(/\s+/g, '');
    // Some submissions put the figures in the code box too, and some leave the
    // batch letter off. Named rather than repaired: recovering "A047" from
    // "A047BUZZ,SURE,LENNY" would be guessing at what somebody meant.
    if (!CODE_SHAPE.test(code)) { rejected.push(`${code || '(blank)'} -> ${cell}`); continue; }

    const names = cell.split(',')
      .map((s) => s.trim().replace(/^[^-]*\s-\s/, ''))
      .filter(Boolean);
    if (names.length !== spec.perCapsule) {
      rejected.push(`${code} names ${names.length}, expected ${spec.perCapsule}`);
      continue;
    }

    const ids = [];
    for (const name of names) {
      if (!roster.has(name)) roster.set(name, keep.get(name) || build.slug(name));
      ids.push(roster.get(name));
    }
    ids.sort();
    if (!byCode.has(code)) byCode.set(code, new Map());
    byCode.get(code).set(ids.join('|'), ids);
  }

  const figures = [...roster]
    .map(([name, id]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(figures.map((f) => f.id)).size !== figures.length) {
    throw new Error(`${spec.id}: duplicate figure id`);
  }

  const agreed = {};
  const disputed = {};
  for (const [code, variants] of [...byCode].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (variants.size === 1) agreed[code] = [...variants.values()][0];
    else disputed[code] = [...variants.values()];
  }

  const batches = {};
  for (const code of Object.keys(agreed)) {
    const letter = (code.match(/^[A-Z]+/) || ['#'])[0];
    batches[letter] = (batches[letter] || 0) + 1;
  }

  const sheet = SHEETS[spec.sheet];
  const retrieved = new Date().toISOString().slice(0, 10);

  const set = {
    id: spec.id,
    brand: spec.brand,
    name: spec.name,
    packaging: spec.packaging,
    packagingNote: spec.packagingNote,
    emoji: spec.emoji,
    official: spec.official,
    figuresPerCapsule: spec.perCapsule,
    verified: false,
    sourced: spec.sourced,
    rarityNote: spec.rarityNote,
    figures,
    codeFile: `codes-${spec.id}.json`,
    codeNote: CODE_NOTE,
    codeLink: spec.wiki,
    codeLinkLabel: spec.wikiLabel,
  };

  fs.writeFileSync(path.join(setsDir, `${spec.id}.json`), `${JSON.stringify(set, null, 1)}\n`);
  fs.writeFileSync(
    path.join(setsDir, `codes-${spec.id}.json`),
    `${JSON.stringify({
      setId: spec.id,
      source: {
        title: sheet.title, credit: sheet.credit, url: sheet.url, csv: sheet.csv, retrieved,
      },
      batches,
      codes: agreed,
      disputed,
    }, null, 1)}\n`,
  );

  const covered = new Set(Object.values(agreed).flat());
  console.log(`${spec.id}: ${figures.length} figures, ${Object.keys(agreed).length} codes, `
    + `${Object.keys(disputed).length} disputed, ${covered.size}/${figures.length} covered`);
  if (rejected.length) {
    console.log(`  ${rejected.length} row(s) ignored as malformed:`);
    for (const r of rejected) console.log(`     ${r}`);
  }
}

function main() {
  const local = process.argv[2];
  const cache = new Map();
  for (const spec of SETS) {
    const sheet = SHEETS[spec.sheet];
    if (!cache.has(spec.sheet)) {
      cache.set(spec.sheet, local ? fs.readFileSync(local, 'utf8') : fetchSheet(sheet));
    }
    buildSet(spec, cache.get(spec.sheet));
  }
}

main();
