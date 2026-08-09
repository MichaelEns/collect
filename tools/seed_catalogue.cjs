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
 * Name each image after the figure id:
 *
 *   pics/grogu.jpg  pics/r2-d2.jpg  pics/darth-vader.jpg
 *
 * ...or after the series AND the figure, when the same character appears in
 * more than one series with a different sculpt:
 *
 *   pics/sw-galaxy-peek-s1__luke-skywalker.jpg
 *   pics/sw-galaxy-peek-s5__luke-skywalker.jpg
 *
 * That second form matters more than it looks. Eighteen ids appear in several
 * series — 42 cards in all — and Luke in Series 1 is not the same figure as
 * Luke in Series 5. A flat name is sent to EVERY series carrying that id, so
 * where a character recurs it necessarily shows the wrong sculpt on all but
 * one card. Flat names still work and are still the easy path; they are simply
 * refused for the recurring ids, where being right requires saying which
 * series you mean.
 *
 * Ids are checked against the set files, so a typo is reported rather than
 * quietly uploading nothing.
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

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

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

/*
 * What is actually in the folder.
 *
 * The picture fetcher also saves photographs of the capsule, bag, box and
 * paper checklist, prefixed "ref-". Those are worth keeping locally but they
 * are not figures, and before they were skipped here their presence stopped
 * the whole run: every one of them was reported as a name matching no figure.
 */
const isReference = (f) => /(^|__)ref-/.test(path.basename(f).toLowerCase());
const files = fs.readdirSync(dir)
  .filter((f) => EXTS.includes(path.extname(f).toLowerCase()))
  .filter((f) => !isReference(f));
if (!files.length) die(`no ${EXTS.join('/')} files in ${dir}`);

const uploads = [];
const unknown = [];
const tooBig = [];
const ambiguous = [];

/*
 * "<setId>__<figureId>" names one card exactly; a bare "<figureId>" names the
 * character wherever it appears. The separator is a double underscore because
 * every set id and figure id already contains single hyphens, so anything
 * shorter could not be split back apart reliably.
 */
function parseName(file) {
  const stem = path.basename(file, path.extname(file)).toLowerCase();
  const split = stem.indexOf('__');
  if (split === -1) return { figureId: stem, setId: null };
  return { setId: stem.slice(0, split), figureId: stem.slice(split + 2) };
}

for (const file of files) {
  const { setId, figureId } = parseName(file);
  if (!wanted.has(figureId)) { unknown.push(file); continue; }
  const series = wanted.get(figureId);
  if (setId && !series.includes(setId)) {
    unknown.push(`${file} — "${figureId}" is not in ${setId} (it is in ${series.join(', ')})`);
    continue;
  }
  /*
   * A flat name for a character that recurs cannot be right for every series
   * it lands in, and quietly picking one sculpt to show on all of them is the
   * kind of confidently-wrong answer this app exists not to give.
   */
  if (!setId && series.length > 1) {
    ambiguous.push(`${file} — "${figureId}" is in ${series.length} series (${series.join(', ')})`);
    continue;
  }
  const full = path.join(dir, file);
  const bytes = fs.readFileSync(full);
  if (bytes.length > MAX_BYTES) { tooBig.push(`${file} (${Math.round(bytes.length / 1024)}KB)`); continue; }
  const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  for (const target of setId ? [setId] : series) {
    uploads.push({ setId: target, figureId, bytes, hash, file });
  }
}

/*
 * A name that matches nothing is almost always a typo or a different naming
 * scheme, and silently skipping it would look like a successful run that did
 * nothing. Refuse rather than half-upload.
 */
if (unknown.length) {
  die(`these file names match no figure id in sets/:\n  ${unknown.join('\n  ')}\n\n`
    + 'Name each file after the figure id, e.g. grogu.jpg, r2-d2.jpg,\n'
    + 'or after both, e.g. sw-galaxy-peek-s1__luke-skywalker.jpg.\n'
    + `Ids available: ${[...wanted.keys()].slice(0, 8).join(', ')}, ...`);
}
if (ambiguous.length) {
  die('these characters appear in more than one series, so a single flat name\n'
    + 'cannot say which sculpt it is:\n  ' + ambiguous.join('\n  ') + '\n\n'
    + 'Name them "<setId>__<figureId>.jpg" instead, e.g.\n'
    + '  sw-galaxy-peek-s1__luke-skywalker.jpg\n'
    + '  sw-galaxy-peek-s5__luke-skywalker.jpg\n\n'
    + 'Uploading one picture to all of them would put the wrong figure on the card.');
}
if (tooBig.length) {
  die(`these are over the ${MAX_BYTES / 1024}KB ceiling the worker enforces:\n  ${tooBig.join('\n  ')}\n\n`
    + 'Shrink them first — 480px on the long edge is all a card ever shows.');
}

/*
 * Two files naming the same card is not a duplicate to deduplicate — it is two
 * different pictures, and whichever happened to be sent last would win. That
 * really happened: a ".jpg" and a ".png" existed for five figures, and among
 * them "imperial-royal-guard.jpg" was a photograph of the checklist sheet
 * while the ".png" was the figure, and "shaak-ti.png" was a different figure
 * altogether. Both were left over from bugs fixed long before, because the
 * picture fetcher only ever adds files and never takes one away.
 */
const perCard = new Map();
for (const up of uploads) {
  const wire = `${up.setId}:${up.figureId}`;
  if (!perCard.has(wire)) perCard.set(wire, new Set());
  perCard.get(wire).add(up.file);
}
const collisions = [...perCard].filter(([, f]) => f.size > 1);
if (collisions.length) {
  die('more than one picture claims the same card, so which one shows would\n'
    + 'depend on upload order:\n  '
    + collisions.map(([wire, f]) => `${wire} <- ${[...f].join(', ')}`).join('\n  ')
    + '\n\nDelete the wrong one. If you cannot tell which is wrong, look at them:\n'
    + 'one of them is not the figure on the card.');
}

const missing = [...wanted.keys()].filter((id) => !files.some(
  (f) => parseName(f).figureId === id
));

const cards = [...wanted.values()].reduce((n, series) => n + series.length, 0);
console.log(`${uploads.length} upload(s) covering ${cards} card(s) across `
  + `${setFiles.length} series, from ${files.length} image(s).`);
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
  let removed = 0;

  /*
   * A picture that used to be here and no longer is has to be taken down, not
   * merely left alone. This tool only ever wrote, so when the Series 5 Leia
   * image turned out to be the Aurra Sing picture under the wrong name and was
   * withdrawn, the wrong picture stayed on the card — a rebuild "fixed" nothing
   * a device could see. A figure with no picture shows its letters, which is
   * honest; a figure showing somebody else is not.
   */
  const wire = (u) => `${u.setId}:${u.figureId}`;
  const shouldExist = new Set(uploads.map(wire));
  let stale = [];
  try {
    const response = await fetch(`${ENDPOINT}/v1/collection?t=${Date.now()}`, {
      headers: { 'X-Family-Code': code },
    });
    if (response.status === 401) die('\nthat family code was not recognised.', 3);
    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      stale = Object.keys(body.catalogue || {}).filter((k) => !shouldExist.has(k));
    }
  } catch (err) {
    console.error(`could not check what is already there (${err.message})`);
  }

  if (stale.length) {
    console.log(`${stale.length} picture(s) no longer have a source and will be taken down:`);
    for (const key of stale) console.log(`  ${key}`);
  }

  /*
   * The worker rate-limits on IP at 60 requests a minute, and this sends one
   * request per picture — so firing them off as fast as the network allows
   * gets the whole run thrown away with 429s, which is exactly what happened
   * the first time a full folder was seeded. Pace under the limit, and treat
   * a 429 as "wait, then try again" rather than as a failure: the seeding is
   * a one-off, so taking three minutes over it costs nothing.
   */
  const SPACING_MS = 1100;
  const MAX_ATTEMPTS = 4;

  for (const up of uploads) {
    const url = `${ENDPOINT}/v1/catalogue/${encodeURIComponent(up.setId)}/${encodeURIComponent(up.figureId)}`;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        const response = await fetch(url, {
          method: 'PUT',
          headers: { 'X-Family-Code': code, 'X-Photo-Hash': up.hash, 'Content-Type': 'image/jpeg' },
          body: up.bytes,
        });
        if (response.status === 401) die('\nthat family code was not recognised.', 3);
        if (response.status === 404) {
          const body = await response.text();
          if (/no such thing/.test(body)) {
            die('\nthe deployed worker does not have the /v1/catalogue route.\n'
              + 'The feature is in this checkout but has not been released:\n'
              + '  cd worker && npx wrangler deploy\n', 4);
          }
        }
        if (response.status === 429 && attempt < MAX_ATTEMPTS) {
          // Back off further each time, so a queue that has built up drains
          // rather than every client retrying into the same window.
          await sleep(SPACING_MS * 4 * attempt);
          continue;
        }
        if (!response.ok) {
          failed += 1;
          console.error(`\n  FAILED ${up.setId}/${up.figureId}: ${response.status} ${await response.text()}`);
          break;
        }
        const body = await response.json().catch(() => ({}));
        if (body.unchanged) { skipped += 1; } else { sent += 1; }
        process.stdout.write(`\r  ${sent} sent, ${skipped} already there, ${failed} failed   `);
        break;
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) { await sleep(SPACING_MS * 2 * attempt); continue; }
        failed += 1;
        console.error(`\n  FAILED ${up.setId}/${up.figureId}: ${err.message}`);
        break;
      }
    }
    await sleep(SPACING_MS);
  }

  for (const key of stale) {
    const [setId, figureId] = key.split(':');
    const url = `${ENDPOINT}/v1/catalogue/${encodeURIComponent(setId)}/${encodeURIComponent(figureId)}`;
    try {
      const response = await fetch(url, { method: 'DELETE', headers: { 'X-Family-Code': code } });
      if (response.ok) { removed += 1; } else {
        failed += 1;
        console.error(`  FAILED to remove ${key}: ${response.status}`);
      }
    } catch (err) {
      failed += 1;
      console.error(`  FAILED to remove ${key}: ${err.message}`);
    }
    await sleep(SPACING_MS);
  }

  console.log(`\n\ndone: ${sent} sent, ${skipped} already there, `
    + `${removed} taken down, ${failed} failed.`);
  if (sent || removed) console.log('Devices pick these up on their next sync.');
  process.exit(failed ? 1 : 0);
}

main();
