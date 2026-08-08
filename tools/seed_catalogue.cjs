#!/usr/bin/env node
/**
 * Uploads catalogue pictures — what each figure looks like — into one family's
 * sync store, so a figure he has not found yet still shows a picture instead of
 * two letters. His own photo takes over the moment he finds one.
 *
 *   COLLECT_FAMILY_CODE="four words here" node tools/seed_catalogue.cjs ./pics
 *
 * Why this is a tool and not part of the app:
 *
 *   The pictures do NOT go in the repo. The repo is public, and a file in it is
 *   fetchable by URL whatever the app chooses to render — manufacturer artwork
 *   there would be published to the world. Sent here instead, it is reachable
 *   only with the family code. That is the difference between publishing
 *   something and keeping a copy at home, and it is the whole reason this
 *   exists as a separate step run by a person.
 *
 *   It follows that this script never sources pictures itself. It uploads a
 *   folder you assembled and are entitled to use.
 *
 * The folder is flat, one image per figure, named by figure id:
 *
 *   pics/grogu.jpg  pics/r2-d2.jpg  pics/darth-vader.jpg
 *
 * Ids are checked against the set files, so a typo is reported rather than
 * quietly uploading nothing. A figure appearing in several series is uploaded
 * once per series it appears in.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENDPOINT = process.env.COLLECT_ENDPOINT || 'https://collect-sync.michaelens.workers.dev';
const MAX_BYTES = 512 * 1024;          // must match MAX_PHOTO_BYTES in the worker
const EXTS = ['.jpg', '.jpeg', '.png', '.webp'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dir = args.find((a) => !a.startsWith('--'));

/*
 * The code is a shared secret. Env var only: a CLI argument lands in shell
 * history and a file would eventually be committed by someone in a hurry.
 */
const code = (process.env.COLLECT_FAMILY_CODE || '').trim().toLowerCase();

function die(message, exitCode = 2) {
  console.error(message);
  process.exit(exitCode);
}

if (!dir) {
  die('usage: COLLECT_FAMILY_CODE="..." node tools/seed_catalogue.cjs <folder> [--dry-run]');
}
if (!code) {
  die('COLLECT_FAMILY_CODE is not set.\n'
    + 'Set it in the environment for this one command rather than saving it anywhere:\n'
    + '  PowerShell:  $env:COLLECT_FAMILY_CODE="four words here"\n'
    + '  bash:        export COLLECT_FAMILY_CODE="four words here"');
}
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  die(`not a folder: ${dir}`);
}

/*
 * Which figure ids are real, and which series each belongs to.
 *
 * Driven off sets/index.json rather than "every .json in sets/ that does not
 * look like something else". That folder also holds code tables, a format note
 * and an id lock file, and a filename blocklist silently acquires a new mistake
 * every time someone adds a file. The index is the manifest; use it.
 */
const setsDir = path.join(__dirname, '..', 'sets');
const indexFile = path.join(setsDir, 'index.json');
if (!fs.existsSync(indexFile)) die('sets/index.json is missing — is this the right checkout?');

const setFiles = JSON.parse(fs.readFileSync(indexFile, 'utf8')).map((entry) => entry.file);

const wanted = new Map();      // figureId -> [setId, ...]
for (const file of setFiles) {
  const full = path.join(setsDir, file);
  if (!fs.existsSync(full)) die(`sets/index.json lists ${file}, which does not exist.`);
  const set = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!set || !Array.isArray(set.figures)) die(`${file} has no figures array.`);
  for (const figure of set.figures) {
    if (!wanted.has(figure.id)) wanted.set(figure.id, []);
    wanted.get(figure.id).push(set.id);
  }
}
if (!wanted.size) die('no figures found in sets/ — is this the right checkout?');

/* What is actually in the folder. */
const files = fs.readdirSync(dir).filter((f) => EXTS.includes(path.extname(f).toLowerCase()));
if (!files.length) die(`no ${EXTS.join('/')} files in ${dir}`);

const uploads = [];
const unknown = [];
const tooBig = [];

for (const file of files) {
  const id = path.basename(file, path.extname(file)).toLowerCase();
  if (!wanted.has(id)) { unknown.push(file); continue; }
  const full = path.join(dir, file);
  const bytes = fs.readFileSync(full);
  if (bytes.length > MAX_BYTES) { tooBig.push(`${file} (${Math.round(bytes.length / 1024)}KB)`); continue; }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  for (const setId of wanted.get(id)) uploads.push({ setId, figureId: id, bytes, hash, file });
}

/*
 * A name that matches nothing is almost always a typo or a different naming
 * scheme, and silently skipping it would look like a successful run that did
 * nothing. Refuse rather than half-upload.
 */
if (unknown.length) {
  die(`these file names match no figure id in sets/:\n  ${unknown.join('\n  ')}\n\n`
    + 'Name each file after the figure id, e.g. grogu.jpg, r2-d2.jpg.\n'
    + `Ids available: ${[...wanted.keys()].slice(0, 8).join(', ')}, ...`);
}
if (tooBig.length) {
  die(`these are over the ${MAX_BYTES / 1024}KB ceiling the worker enforces:\n  ${tooBig.join('\n  ')}\n\n`
    + 'Shrink them first — 480px on the long edge is all a card ever shows.');
}

const missing = [...wanted.keys()].filter((id) => !files.some(
  (f) => path.basename(f, path.extname(f)).toLowerCase() === id
));

console.log(`${uploads.length} upload(s) across ${setFiles.length} series, from ${files.length} image(s).`);
if (missing.length) {
  console.log(`${missing.length} figure(s) have no picture yet and will keep their letter tag:`);
  console.log(`  ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', ...' : ''}`);
}
if (dryRun) {
  console.log('\n--dry-run: nothing was sent.');
  process.exit(0);
}

async function main() {
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const up of uploads) {
    const url = `${ENDPOINT}/v1/catalogue/${encodeURIComponent(up.setId)}/${encodeURIComponent(up.figureId)}`;
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'X-Family-Code': code, 'X-Photo-Hash': up.hash, 'Content-Type': 'image/jpeg' },
        body: up.bytes,
      });
      if (response.status === 401) die('\nthat family code was not recognised.', 3);
      if (!response.ok) {
        failed += 1;
        console.error(`  FAILED ${up.setId}/${up.figureId}: ${response.status} ${await response.text()}`);
        continue;
      }
      const body = await response.json().catch(() => ({}));
      if (body.unchanged) { skipped += 1; } else { sent += 1; }
      process.stdout.write(`\r  ${sent} sent, ${skipped} already there, ${failed} failed`);
    } catch (err) {
      failed += 1;
      console.error(`\n  FAILED ${up.setId}/${up.figureId}: ${err.message}`);
    }
  }

  console.log(`\n\ndone: ${sent} sent, ${skipped} already there, ${failed} failed.`);
  if (sent) console.log('Devices pick these up on their next sync.');
  process.exit(failed ? 1 : 0);
}

main();
