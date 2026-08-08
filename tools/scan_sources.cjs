#!/usr/bin/env node
/**
 * Looks for new capsule codes and new series, and reports what it finds.
 *
 * Why this exists
 * ---------------
 * The rosters and codes come from a community spreadsheet and a fan wiki, both
 * of which move, get renamed, and go away without telling anyone. That already
 * happened once: the sheet this app was built from now 404s, so the pipeline
 * could not be re-run and the app was still offering the dead URL to people as
 * its source. Nothing failed loudly, because nothing was watching.
 *
 * What it deliberately does NOT do
 * --------------------------------
 * It never writes to sets/. Rosters are community guesswork, and this app's
 * whole posture is that a confidently wrong checklist is worse than none — so
 * a machine that quietly rewrote a child's checklist from a page that changed
 * overnight would be the worst possible feature. It reports; a person decides.
 *
 * Findings are graded by what they would cost:
 *
 *   ok        nothing changed
 *   additive  new codes, new figures, a new series — safe to take, because
 *             progress is keyed by id and unknown ids simply read as unfound
 *   breaking  an id that progress is stored against would change or vanish
 *   broken    a source the app cites is unreachable, so it cannot be checked
 *
 * Usage
 *   node tools/scan_sources.cjs                 # check the live sources
 *   node tools/scan_sources.cjs --csv f.csv     # check a local sheet export
 *   node tools/scan_sources.cjs --json report.json
 *   node tools/scan_sources.cjs --offline       # skip the network entirely
 *
 * Exit codes: 0 nothing to do, 10 additive findings, 20 needs a person.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const build = require('./build_codes.cjs');

const SETS = path.join(__dirname, '..', 'sets');

/*
 * Fandom refuses Node's fetch outright — 403 no matter what headers are sent,
 * because undici is fingerprintable at the TLS layer — while curl with the
 * same User-Agent gets 200. So curl is the client here, with fetch only as a
 * fallback. Getting this wrong meant the first run of this tool reported a
 * perfectly healthy wiki as a dead link, and a weekly report that cries wolf
 * is one that stops being read.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  + ' (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TIMEOUT_S = 25;

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SETS, f), 'utf8'));
const NOT_A_SET = new Set(['index.json', 'FORMAT.json', 'ids.lock.json']);

let curlChecked = false;
let haveCurl = false;
function curlAvailable() {
  if (!curlChecked) {
    curlChecked = true;
    haveCurl = spawnSync('curl', ['--version'], { encoding: 'utf8' }).status === 0;
  }
  return haveCurl;
}

function getViaCurl(url) {
  const tmp = path.join(os.tmpdir(), `scan-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    const res = spawnSync('curl', [
      '-sS', '-L', '--max-time', String(TIMEOUT_S),
      '-A', UA,
      '-H', 'Accept-Language: en-US,en;q=0.9',
      '-o', tmp,
      '-w', '%{http_code}',
      url,
    ], { encoding: 'utf8' });
    const status = parseInt((res.stdout || '').trim(), 10) || 0;
    const body = fs.existsSync(tmp) ? fs.readFileSync(tmp, 'utf8') : '';
    return { ok: status >= 200 && status < 400, status, body, error: status ? null : 'curl failed' };
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

async function getViaFetch(url) {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), TIMEOUT_S * 1000);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: control.signal,
      headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    return { ok: response.ok, status: response.status, body: await response.text(), error: null };
  } catch (err) {
    return { ok: false, status: 0, body: '', error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function get(url) {
  if (curlAvailable()) {
    const res = getViaCurl(url);
    if (res.status) return res;
  }
  return getViaFetch(url);
}

/**
 * A refusal is not a death.
 *
 * 403 and 429 mean "we would not serve you", which is what bot protection
 * says to a script and says nothing about whether the page is still there.
 * Reporting those as dead links would produce a false alarm every single week.
 */
const BLOCKED = new Set([401, 403, 405, 406, 429]);

/** Every outward link the app ships, and where each one is used. */
function shippedLinks() {
  const links = new Map();
  const note = (url, where) => {
    if (!url) return;
    if (!links.has(url)) links.set(url, new Set());
    links.get(url).add(where);
  };
  for (const file of fs.readdirSync(SETS).filter((f) => f.endsWith('.json'))) {
    if (NOT_A_SET.has(file)) continue;
    const raw = fs.readFileSync(path.join(SETS, file), 'utf8');
    for (const m of raw.matchAll(/"(https?:\/\/[^"]+)"/g)) note(m[1], file);
  }
  note(build.SOURCE.url, 'the code pipeline');
  return links;
}

/*
 * A published Google Sheet answers 200 with an HTML error page in some failure
 * modes, so "did it 200" is not the question — "is this a spreadsheet" is.
 */
function looksLikeCsv(text) {
  if (!text || /^\s*<(!doctype|html)/i.test(text)) return false;
  const lines = text.split('\n').slice(0, 40);
  return lines.filter((l) => l.split(',').length > 3).length >= 5;
}

function shippedCodes() {
  const out = {};
  for (const file of fs.readdirSync(SETS).filter((f) => f.startsWith('codes-'))) {
    const data = JSON.parse(fs.readFileSync(path.join(SETS, file), 'utf8'));
    out[data.setId] = data;
  }
  return out;
}

function shippedSets() {
  const out = {};
  for (const meta of readJson('index.json')) out[meta.id] = readJson(meta.file);
  return out;
}

/** Compares a freshly parsed sheet against what the app currently ships. */
function diffAgainstShipped(rosters, codes) {
  const findings = [];
  const sets = shippedSets();
  const shipped = shippedCodes();

  for (let s = 1; s <= build.SERIES_COUNT; s += 1) {
    const setId = `sw-galaxy-peek-s${s}`;
    const set = sets[setId];
    if (!set) continue;

    const liveById = new Map(rosters[s].map((f) => [f.id, f]));
    const haveById = new Map(set.figures.map((f) => [f.id, f]));

    for (const [id, figure] of liveById) {
      if (!haveById.has(id)) {
        findings.push({
          level: 'additive',
          kind: 'figure-added',
          setId,
          detail: `"${figure.name}" (${id}) is in the sheet but not in the app`,
        });
      }
    }
    /*
     * The dangerous direction. build_codes carries ids over by NAME, so a
     * respelling in the sheet mints a fresh id and abandons the old one —
     * which is a child's tick going quiet, not a cosmetic change.
     */
    for (const [id, figure] of haveById) {
      if (!liveById.has(id)) {
        findings.push({
          level: 'breaking',
          kind: 'figure-id-lost',
          setId,
          detail: `"${figure.name}" (${id}) is in the app but the sheet no longer produces that id`
            + ' — rebuilding would orphan any tick against it',
        });
      }
    }
    for (const [id, figure] of liveById) {
      const mine = haveById.get(id);
      if (!mine) continue;
      if (mine.name !== figure.name) {
        findings.push({
          level: 'additive',
          kind: 'figure-renamed',
          setId,
          detail: `${id}: "${mine.name}" -> "${figure.name}" (id preserved, so no progress is lost)`,
        });
      }
      if (mine.rarity !== figure.rarity) {
        findings.push({
          level: 'additive',
          kind: 'rarity-changed',
          setId,
          detail: `${figure.name}: ${mine.rarity} -> ${figure.rarity}`,
        });
      }
    }

    const agreed = (shipped[setId] || {}).codes || {};
    const live = codes[s] ? codes[s].codes : new Map();
    const added = [];
    const changed = [];
    for (const [code, variants] of live) {
      if (variants.size !== 1) continue;
      const ids = [...variants.values()][0];
      if (!(code in agreed)) { added.push(code); continue; }
      if (agreed[code].join('|') !== ids.join('|')) changed.push(code);
    }
    const gone = Object.keys(agreed).filter((c) => !live.has(c));

    if (added.length) {
      findings.push({
        level: 'additive',
        kind: 'codes-added',
        setId,
        detail: `${added.length} new capsule code(s): ${added.slice(0, 12).join(', ')}`
          + `${added.length > 12 ? ` and ${added.length - 12} more` : ''}`,
      });
    }
    if (changed.length) {
      // Not breaking (codes carry no progress) but it means somebody corrected
      // a capsule, and the app is currently telling a child the old answer.
      findings.push({
        level: 'breaking',
        kind: 'codes-changed',
        setId,
        detail: `${changed.length} code(s) now list different figures: ${changed.slice(0, 12).join(', ')}`,
      });
    }
    if (gone.length) {
      findings.push({
        level: 'additive',
        kind: 'codes-withdrawn',
        setId,
        detail: `${gone.length} code(s) the app knows are no longer in the sheet: ${gone.slice(0, 12).join(', ')}`,
      });
    }
  }
  return findings;
}

/**
 * Is there a series nobody has added yet?
 *
 * An earlier version of this asked "is the row after the last checklist block
 * empty?" and was wrong every time: the sheet's Star Wars column keeps going
 * past Galaxy Peek into Widescreen, Squish Squadron and the Grogu sets, so it
 * announced a new series on its very first run. A check that cries wolf weekly
 * is worse than no check, so both signals below are ones that only fire on
 * something real.
 */
function seriesInCodeRows(rows) {
  const seen = new Set();
  for (const row of rows) {
    const g = row.findIndex((c) => String(c).trim() === 'Galaxy');
    if (g < 1) continue;
    const series = parseInt(String(row[g + 2] || '').trim(), 10);
    if (Number.isInteger(series)) seen.add(series);
  }
  return seen;
}

async function probeNewSeries(offline) {
  const next = build.SERIES_COUNT + 1;
  if (offline) return [];
  const findings = [];

  // Just Play's own product page. Their slugs are not perfectly consistent
  // across series, so a 404 proves nothing — but a 200 is the manufacturer
  // saying it exists, which is as good as the signal gets.
  const url = `https://justplayproducts.com/products/star-wars-doorables-galaxy-peek-capsule-series-${next}/`;
  const res = await get(url);
  if (res.ok) {
    findings.push({
      level: 'additive',
      kind: 'series-announced',
      setId: `sw-galaxy-peek-s${next}`,
      detail: `Just Play now has a product page for Series ${next}: ${url}`,
    });
  }
  return findings;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes('--offline');
  const csvArg = args.includes('--csv') ? args[args.indexOf('--csv') + 1] : null;
  const jsonArg = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

  const findings = [];
  const checked = [];

  if (!offline) {
    for (const [url, where] of shippedLinks()) {
      const res = await get(url);
      checked.push({ url, status: res.status, ok: res.ok });
      if (res.ok) continue;
      if (BLOCKED.has(res.status)) {
        findings.push({
          level: 'note',
          kind: 'link-blocked',
          setId: null,
          detail: `${url} answered ${res.status} to an automated request.`
            + ' That is bot protection rather than a dead page, so it is worth'
            + ' opening by hand once rather than acting on.',
        });
        continue;
      }
      findings.push({
        level: 'broken',
        kind: 'link-dead',
        setId: null,
        detail: `${url} answered ${res.status || res.error}`
          + ` — cited by ${[...where].join(', ')}`,
      });
    }
  }

  let csv = null;
  if (csvArg) {
    csv = fs.readFileSync(csvArg, 'utf8');
  } else if (!offline) {
    const sheet = build.SOURCE.csv || null;
    if (sheet) {
      const res = await get(sheet);
      if (res.ok && looksLikeCsv(res.body)) csv = res.body;
      else {
        findings.push({
          level: 'broken',
          kind: 'sheet-unreadable',
          setId: null,
          detail: `${sheet} did not return a spreadsheet (${res.status || res.error})`
            + ' — codes cannot be checked until a working source is recorded in'
            + ' SOURCE.csv in tools/build_codes.cjs',
        });
      }
    } else {
      findings.push({
        level: 'broken',
        kind: 'no-sheet-configured',
        setId: null,
        detail: 'no machine-readable code source is recorded (SOURCE.csv in'
          + ' tools/build_codes.cjs is unset), so new codes cannot be detected'
          + ' automatically — only new series and dead links are checked',
      });
    }
  }

  if (csv) {
    try {
      const rows = build.parseCsv(csv);
      const rosters = build.readRosters(rows);
      const codes = build.readCodes(rows, rosters);
      findings.push(...diffAgainstShipped(rosters, codes));
      /*
       * Capsule rows carry their own series number, so a Series 6 with real
       * codes announces itself here — precisely, and only when the data the
       * app would actually consume exists.
       */
      for (const series of [...seriesInCodeRows(rows)].sort((a, b) => a - b)) {
        if (series >= 1 && series <= build.SERIES_COUNT) continue;
        findings.push({
          level: 'additive',
          kind: 'series-in-codes',
          setId: `sw-galaxy-peek-s${series}`,
          detail: `the sheet has capsule codes for Series ${series}, which the app`
            + ' does not know about. Adding a series is a code change, not just data:'
            + ' raise SERIES_COUNT in tools/build_codes.cjs and add a META entry'
            + ' (capsule description, item number, release date) in tools/build_sets.cjs.',
        });
      }
    } catch (err) {
      // The parser throws rather than guessing, so this is the sheet having
      // been restructured — which is a person's problem, not a data update.
      findings.push({
        level: 'breaking',
        kind: 'sheet-shape-changed',
        setId: null,
        detail: `the sheet no longer parses: ${err.message}`,
      });
    }
  }

  findings.push(...await probeNewSeries(offline));

  const needsPerson = findings.some((f) => f.level === 'breaking' || f.level === 'broken');
  const worth = findings.some((f) => f.level !== 'note');
  const worst = needsPerson ? 'attention' : worth ? 'additive' : findings.length ? 'note' : 'ok';

  const report = {
    scanned: new Date().toISOString(),
    verdict: worst,
    checked,
    findings,
  };
  if (jsonArg) fs.writeFileSync(jsonArg, `${JSON.stringify(report, null, 1)}\n`);

  const order = {
    broken: 0, breaking: 1, additive: 2, note: 3,
  };
  const label = {
    broken: 'SOURCE UNREACHABLE',
    breaking: 'NEEDS A DECISION',
    additive: 'SAFE TO ADD',
    note: 'FOR INFORMATION',
  };
  if (!findings.length) {
    console.log('Nothing has changed. No new codes, no new series, every source reachable.');
  } else {
    for (const f of findings.slice().sort((a, b) => order[a.level] - order[b.level])) {
      console.log(`[${label[f.level]}] ${f.kind}${f.setId ? ` (${f.setId})` : ''}`);
      console.log(`    ${f.detail}\n`);
    }
    if (findings.some((f) => f.level === 'breaking')) {
      console.log('Do not rebuild until the breaking items are understood: rebuilding'
        + '\nwould change ids a child\'s progress is stored against.');
    } else if (findings.some((f) => f.level === 'broken')) {
      console.log('A source the app cites cannot be read, so this scan could not check'
        + '\neverything. Nothing here says the shipped data is wrong — only that it'
        + '\ncan no longer be confirmed, and that the app is offering a link that fails.');
    } else if (findings.some((f) => f.level === 'additive')) {
      console.log('These are additive. Rebuilding is safe: progress is keyed by id, and'
        + '\nids not yet found simply read as unfound. Run tools/lock_ids.cjs afterwards'
        + '\nto confirm nothing was lost.');
    } else {
      console.log('Nothing needs doing.');
    }
  }

  process.exit(worst === 'attention' ? 20 : worst === 'additive' ? 10 : 0);
}

main();
