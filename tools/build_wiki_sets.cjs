#!/usr/bin/env node
/**
 * Builds checklist-only sets from the wiki's own tables.
 *
 * Most sets here come from the community code sheets, because a code sheet is
 * what makes the finder work. Two lines have a published checklist but nobody
 * has submitted codes for them yet — the sheet's "Squish 1" and "Grogu 2"
 * columns exist and are completely empty. Those still belong in the app: Joe
 * can tick off what he owns and see what is left, which is most of the point.
 * They simply ship with no finder, and say so.
 *
 * The wiki tables are regular: one row per figure, a linked name, a photo, a
 * rarity cell coloured by rarity. Nothing here is inferred — a row that does
 * not yield a name and a rarity stops the build rather than shipping a gap.
 *
 *   node tools/build_wiki_sets.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const build = require('./build_codes.cjs');

const setsDir = path.join(__dirname, '..', 'sets');

// Fandom refuses Node's fetch whatever headers it is given, but answers curl.
// The wiki's robots.txt explicitly allows /api.php?action= for every agent.
const UA = 'collect-tracker/1.0 (personal collection tracker)';
const API = 'https://disney-doorables.fandom.com/api.php';

const RARITIES = [
  { id: 'common', label: 'Common', colour: '#8fa3d9' },
  { id: 'rare', label: 'Rare', colour: '#7ee8ff' },
  { id: 'ultra', label: 'Ultra Rare', colour: '#ffc93d' },
  { id: 'special', label: 'Special Edition', colour: '#ff7ad9' },
];

const RARITY_ID = {
  common: 'common',
  rare: 'rare',
  'ultra rare': 'ultra',
  'special edition': 'special',
};

/** Words in a photo's filename that mark the line, not the figure. */
const FILE_NOISE = /^(sq|sws|s\d|gp|swgp|png|jpg|jpeg|mini|capsule|grogumini|gorgumini)$/i;

const SETS = [
  {
    id: 'sw-squish-s1',
    page: 'Star Wars Squish Squadron',
    name: 'Squish Squadron Series 1',
    brand: 'Star Wars Doorables',
    emoji: '🫧',
    perCapsule: 5,
    packaging: 'Blind bag, squishy figures inside',
    packagingNote: 'These are soft squishy figures rather than hard ones.'
      + ' Series 2 bags hold five, and we have assumed the same here — but'
      + ' nobody has confirmed it for Series 1.',
    official: 'https://justplayproducts.com/collections/star-wars-doorables/',
    sourced: 'The checklist published on the Doorables wiki.',
  },
  {
    id: 'sw-grogu-mini',
    page: 'Grogu Mini Capsule',
    name: 'Grogu Mini Capsule',
    brand: 'Star Wars Doorables',
    emoji: '🥚',
    perCapsule: 1,
    packaging: 'Mini capsule, one Grogu inside',
    packagingNote: 'A mini capsule holds ONE Grogu, not four figures. Every one'
      + ' of these is Grogu doing something different.',
    official: 'https://justplayproducts.com/collections/star-wars-doorables/',
    sourced: 'The checklist published on the Doorables wiki.',
  },
];

function wikitext(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json`;
  const body = execFileSync('curl', ['-sSL', '--max-time', '60', '-A', UA, url],
    { encoding: 'utf8', maxBuffer: 64e6 });
  const json = JSON.parse(body);
  if (!json.parse) throw new Error(`the wiki has no page called "${page}" any more`);
  return json.parse.wikitext['*'];
}

/** The visible text of a cell, with the wiki's styling spans taken off. */
const plain = (s) => String(s || '')
  // A line break is a space, not nothing: the wiki writes "Jabba<br/>the<br/>Hutt"
  // to make a column fit, and stripping it bare gives "JabbatheHutt".
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]*>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/**
 * Spellings the wiki gets wrong, where the app itself already has the name
 * right somewhere else. Kept tiny and explicit — this is not a place to tidy.
 */
const RENAME = {
  'Bobba Fett': 'Boba Fett', // spelled correctly in Squish Squadron Series 2
};

/**
 * The checklist tables, and only those.
 *
 * These pages also carry photos of the box, the bag and the paper checklist,
 * which are not rows and have no name. Anchoring on a table whose header says
 * "Name" keeps them out, so that a row inside a real table with a photo but no
 * name can still be treated as the error it is.
 */
function checklistTables(text) {
  const tables = [];
  const re = /^\{\|[\s\S]*?^\|\}/gm;
  for (const m of text.match(re) || []) {
    if (/^!.*\|\s*Name\s*$/m.test(m)) tables.push(m);
  }
  return tables;
}

function parseRows(text, page) {
  const rows = [];
  const tables = checklistTables(text);
  if (!tables.length) throw new Error(`${page}: no checklist table on the page any more`);

  for (const chunk of tables.join('\n').split(/^\|-\s*$/m)) {
    const name = plain((chunk.match(/\|\s*\[\[[^\]|]+\|([^\]]+)\]\]/) || [])[1]);    const file = ((chunk.match(/\[\[File:([^\]|]+)/) || [])[1] || '').trim();
    const rarity = plain((chunk.match(/background-color:[^|]*\|([\s\S]*?)(?:\n|$)/) || [])[1]);
    if (!name && !file) continue;
    if (!name) throw new Error(`${page}: a row has a photo (${file}) but no name`);    const id = RARITY_ID[rarity.toLowerCase()];
    if (!id) {
      throw new Error(`${page}: "${name}" has rarity "${rarity}", which is not one of`
        + ` ${Object.keys(RARITY_ID).join(', ')}`);
    }
    rows.push({ name: RENAME[name] || name, file, rarity: id });
  }
  if (!rows.length) throw new Error(`${page}: the table did not parse into any rows`);
  return rows;
}

/**
 * Two rows can share a name — the same character in a different colourway,
 * which is a separate thing to collect. The photo's filename is what tells
 * them apart, so the extra word in it becomes the qualifier.
 *
 * The row whose filename carries no extra word is the plain one, and keeps its
 * plain name: "Ahsoka Tano" and "Ahsoka Tano (Blue)" reads better, and is more
 * true, than calling the first one "Ahsoka Tano (Common)".
 */
function disambiguate(rows, page) {
  const count = new Map();
  for (const row of rows) count.set(row.name, (count.get(row.name) || 0) + 1);

  const extraWords = (row) => {
    const words = new Set(row.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return row.file.replace(/\.[a-z]+$/i, '')
      .split(/[^A-Za-z0-9]+/)
      .filter((w) => w && !words.has(w.toLowerCase()) && !FILE_NOISE.test(w));
  };

  const groups = new Map();
  for (const row of rows) {
    if (count.get(row.name) < 2) continue;
    if (!groups.has(row.name)) groups.set(row.name, []);
    groups.get(row.name).push(row);
  }

  for (const group of groups.values()) {
    const extras = group.map(extraWords);
    const plainRows = extras.filter((e) => !e.length).length;
    group.forEach((row, i) => {
      const extra = extras[i];
      // Exactly one row without a distinguishing word is "the" plain one.
      if (!extra.length && plainRows === 1) return;
      const qualifier = extra.length
        ? extra.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ')
        : RARITIES.find((r) => r.id === row.rarity).label;
      row.name = `${row.name} (${qualifier})`;
    });
  }

  const names = rows.map((r) => r.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) {
    throw new Error(`${page}: still two rows called ${[...new Set(dupes)].join(', ')}`
      + ' — they need telling apart before this can ship');
  }
  return rows;
}

/** Ids already in use are kept, so a rebuild never orphans a child's ticks. */
function existingIds(setId) {
  const file = path.join(setsDir, `${setId}.json`);
  if (!fs.existsSync(file)) return new Map();
  const set = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Map(set.figures.map((f) => [f.name, f.id]));
}

function buildSet(spec) {
  const rows = disambiguate(parseRows(wikitext(spec.page), spec.page), spec.page);
  const keep = existingIds(spec.id);

  const figures = rows.map((row) => ({
    id: keep.get(row.name) || build.slug(row.name),
    name: row.name,
    rarity: row.rarity,
  }));
  if (new Set(figures.map((f) => f.id)).size !== figures.length) {
    throw new Error(`${spec.id}: duplicate figure id`);
  }

  const wiki = `https://disney-doorables.fandom.com/wiki/${spec.page.replace(/ /g, '_')}`;
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
    sourced: `${figures.length} figures. ${spec.sourced}`
      + ' Just Play has not published a checklist for this line, so treat it as'
      + ' very good community data rather than gospel.',
    rarities: RARITIES,
    figures,
    codeLink: wiki,
    codeLinkLabel: `${spec.name} on the Doorables wiki`,
    countNote: 'Nobody has written down any bag codes for this one yet, so there'
      + ' is nothing to look up — this is a checklist only. If codes start being'
      + ' collected, they will appear here.',
  };

  fs.writeFileSync(path.join(setsDir, `${spec.id}.json`), `${JSON.stringify(set, null, 1)}\n`);
  const byRarity = {};
  for (const f of figures) byRarity[f.rarity] = (byRarity[f.rarity] || 0) + 1;
  console.log(`${spec.id}: ${figures.length} figures, no codes — `
    + Object.entries(byRarity).map(([r, n]) => `${n} ${r}`).join(', '));
}

function main() {
  for (const spec of SETS) buildSet(spec);
}

main();
