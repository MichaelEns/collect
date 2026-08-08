#!/usr/bin/env node
/**
 * Writes sets/ids.lock.json — the list of ids a child's progress is stored
 * against.
 *
 * Progress lives under `collect.progress.<setId>` as `{ <figureId>: entry }`,
 * in the browser and in the shared store, so an id is not an implementation
 * detail: it IS the thing that remembers a figure was found. Change one and
 * the tick against it is orphaned, which looks exactly like the app quietly
 * losing a collection.
 *
 * Rosters get rebuilt from a community spreadsheet whose spelling we do not
 * control, and build_codes.cjs matches existing ids BY NAME — so a sheet that
 * renames "Yoda (C)" mints a fresh id and drops the old one without a word.
 * This lock turns that silent event into a failed test.
 *
 * Adding ids is always fine and needs no ceremony. Removing or renaming one is
 * what the lock exists to stop.
 *
 *   node tools/lock_ids.cjs           # fail if the lock and the sets disagree
 *   node tools/lock_ids.cjs --write   # accept the current sets as the truth
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SETS = path.join(__dirname, '..', 'sets');
const LOCK = path.join(SETS, 'ids.lock.json');

function currentIds() {
  const index = JSON.parse(fs.readFileSync(path.join(SETS, 'index.json'), 'utf8'));
  const out = {};
  for (const meta of index.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const set = JSON.parse(fs.readFileSync(path.join(SETS, meta.file), 'utf8'));
    out[meta.id] = set.figures.map((f) => f.id).sort();
  }
  return out;
}

function readLock() {
  if (!fs.existsSync(LOCK)) return null;
  return JSON.parse(fs.readFileSync(LOCK, 'utf8'));
}

/** What changed, in the only terms that matter: what a child would lose. */
function compare(lock, now) {
  const missingSets = Object.keys(lock.sets).filter((s) => !(s in now));
  const addedSets = Object.keys(now).filter((s) => !(s in lock.sets));
  const missingFigures = [];
  const addedFigures = [];
  for (const [setId, ids] of Object.entries(lock.sets)) {
    if (!(setId in now)) continue;
    const have = new Set(now[setId]);
    for (const id of ids) if (!have.has(id)) missingFigures.push(`${setId}/${id}`);
  }
  for (const [setId, ids] of Object.entries(now)) {
    const had = new Set(lock.sets[setId] || []);
    for (const id of ids) if (!had.has(id)) addedFigures.push(`${setId}/${id}`);
  }
  return { missingSets, addedSets, missingFigures, addedFigures };
}

function main() {
  const write = process.argv.includes('--write');
  const now = currentIds();
  const lock = readLock();

  if (!lock || write) {
    const next = {
      note: 'Ids that progress is stored against. Additions are fine; a removal '
        + 'or rename orphans a tick. Run tools/lock_ids.cjs --write only when '
        + 'the change is understood and intended.',
      updated: new Date().toISOString().slice(0, 10),
      sets: now,
    };
    fs.writeFileSync(LOCK, `${JSON.stringify(next, null, 1)}\n`);
    const total = Object.values(now).reduce((n, ids) => n + ids.length, 0);
    console.log(`wrote sets/ids.lock.json — ${Object.keys(now).length} sets, ${total} figures`);
    return;
  }

  const diff = compare(lock, now);
  const lost = [...diff.missingSets.map((s) => `whole set ${s}`), ...diff.missingFigures];
  if (lost.length) {
    console.error('These ids are in the lock but no longer in the sets:\n');
    for (const item of lost) console.error(`  ${item}`);
    console.error('\nProgress is stored against these, so anyone who found one of them'
      + '\nwould lose that tick. If a figure was genuinely renamed, keep its old id'
      + '\nin the set file. Only run --write once you are sure nothing is lost.');
    process.exit(1);
  }

  const gained = [...diff.addedSets.map((s) => `whole set ${s}`), ...diff.addedFigures];
  if (gained.length) {
    console.log(`${gained.length} new id(s), nothing lost:`);
    for (const item of gained) console.log(`  + ${item}`);
    console.log('\nRun `node tools/lock_ids.cjs --write` to record them.');
    return;
  }
  console.log('ids.lock.json matches the sets exactly.');
}

main();
