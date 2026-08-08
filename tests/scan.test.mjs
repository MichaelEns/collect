/*
 * The unattended scan.
 *
 * tools/scan_sources.cjs is meant to run week after week with nobody watching,
 * so the thing that matters is not that it works today but that it still tells
 * the truth when the sheet changes shape underneath it. These tests build a
 * spreadsheet that reproduces exactly what the app currently ships, then break
 * it in the specific ways a community sheet actually breaks.
 *
 * The most important case is the one that costs a child something: a figure
 * respelled in the sheet mints a new id, and progress is stored against ids.
 * The scan must call that BREAKING and not quietly wave it through as an
 * ordinary data update.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SETS = path.join(ROOT, 'sets');
const SCAN = path.join(ROOT, 'tools', 'scan_sources.cjs');
const require_ = createRequire(import.meta.url);
const build = require_(path.join(ROOT, 'tools', 'build_codes.cjs'));

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SETS, f), 'utf8'));

/** sheet spelling -> app spelling, inverted, so a fixture can speak sheet. */
function toSheetName(appName) {
  for (const [sheet, app] of Object.entries(build.RENAME)) if (app === appName) return sheet;
  return appName;
}

const RARITY_WORD = Object.fromEntries(
  Object.entries(build.RARITIES).map(([word, id]) => [id, word]),
);

function put(rows, y, x, value) {
  while (rows.length <= y) rows.push([]);
  const row = rows[y];
  while (row.length <= x) row.push('');
  row[x] = value;
}

/**
 * Rebuilds the community sheet from what the app ships.
 *
 * If the scan reports no differences against this, then the fixture is a
 * faithful stand-in AND the diff is correct — one assertion covering both.
 */
function sheetFromShipped() {
  const rows = [];
  const index = readJson('index.json');
  for (let s = 1; s <= build.SERIES_COUNT; s += 1) {
    const meta = index.find((m) => m.id === `sw-galaxy-peek-s${s}`);
    const set = readJson(meta.file);
    const start = build.FIRST_BLOCK_ROW + (s - 1) * build.BLOCK_SIZE;
    // The sheet is in checklist order; the app sorts by bag number, so the
    // fixture has to sort back or the blocks will not line up.
    const figures = set.figures.slice().sort((a, b) => {
      const an = a.number ? parseInt(a.number, 10) : 99;
      const bn = b.number ? parseInt(b.number, 10) : 99;
      return an - bn;
    });
    figures.forEach((figure, i) => {
      const y = start + i;
      put(rows, y, build.NAME_COL, toSheetName(figure.name));
      put(rows, y, build.RARITY_COL, RARITY_WORD[figure.rarity]);
      put(rows, y, build.BAG_COL, figure.number ? String(parseInt(figure.number, 10)) : '');
    });
  }

  for (let s = 1; s <= build.SERIES_COUNT; s += 1) {
    const setId = `sw-galaxy-peek-s${s}`;
    const file = path.join(SETS, `codes-${setId}.json`);
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const set = readJson(`${setId}.json`);
    const nameById = new Map(set.figures.map((f) => [f.id, toSheetName(f.name)]));
    for (const [code, ids] of Object.entries(data.codes)) {
      const y = rows.length;
      // Layout the parser expects around the "Galaxy" marker: -1 is the code,
      // +2 the series, +4 the four figures inside.
      put(rows, y, 3, 'bag');
      put(rows, y, 5, code);
      put(rows, y, 6, 'Galaxy');
      put(rows, y, 8, String(s));
      put(rows, y, 10, ids.map((id) => nameById.get(id)).join(', '));
    }
  }
  return rows;
}

const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows) => rows.map((r) => r.map((c) => esc(c || '')).join(',')).join('\n');

function runScan(csv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
  const file = path.join(dir, 'codes.csv');
  const report = path.join(dir, 'report.json');
  fs.writeFileSync(file, csv);
  const res = spawnSync(process.execPath,
    [SCAN, '--offline', '--csv', file, '--json', report],
    { encoding: 'utf8' });
  const parsed = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null;
  fs.rmSync(dir, { recursive: true, force: true });
  return { code: res.status, stdout: res.stdout, report: parsed };
}

const kinds = (report) => report.findings.map((f) => f.kind);

test('a sheet identical to what ships produces no findings at all', () => {
  const { code, report } = runScan(toCsv(sheetFromShipped()));
  assert.ok(report, 'the scan wrote no report');
  assert.deepStrictEqual(report.findings, [],
    `expected silence, got: ${JSON.stringify(report.findings, null, 1)}`);
  assert.strictEqual(report.verdict, 'ok');
  assert.strictEqual(code, 0, 'an unchanged sheet must exit 0 so a schedule stays quiet');
});

test('a new capsule code is reported, and reported as safe', () => {
  const rows = sheetFromShipped();
  const set = readJson('sw-galaxy-peek-s2.json');
  const four = set.figures.slice(0, 4).map((f) => toSheetName(f.name)).join(', ');
  const y = rows.length;
  put(rows, y, 3, 'bag');
  put(rows, y, 5, 'ZZ999');
  put(rows, y, 6, 'Galaxy');
  put(rows, y, 8, '2');
  put(rows, y, 10, four);

  const { code, report } = runScan(toCsv(rows));
  assert.ok(kinds(report).includes('codes-added'), JSON.stringify(kinds(report)));
  const finding = report.findings.find((f) => f.kind === 'codes-added');
  assert.match(finding.detail, /ZZ999/);
  assert.strictEqual(finding.level, 'additive',
    'a new code cannot cost anything: it is keyed by code, not by progress');
  assert.strictEqual(code, 10);
});

test('a figure respelled so its id changes is reported as BREAKING', () => {
  /*
   * The whole reason the id lock exists. build_codes carries ids across by
   * name, so "Omega" becoming "Omega (Clone)" in the sheet produces the id
   * omega-clone and abandons omega — and every tick stored against omega.
   */
  const rows = sheetFromShipped();
  let touched = 0;
  for (const row of rows) {
    if (row[build.NAME_COL] === 'Omega') { row[build.NAME_COL] = 'Omega Clone'; touched += 1; }
  }
  assert.ok(touched > 0, 'the fixture no longer contains Omega; pick another figure');
  // The capsule rows name figures too, and they must agree or the parse throws.
  for (const row of rows) {
    if (row[10]) row[10] = row[10].split(', ').map((n) => (n === 'Omega' ? 'Omega Clone' : n)).join(', ');
  }

  const { code, report } = runScan(toCsv(rows));
  const lost = report.findings.find((f) => f.kind === 'figure-id-lost');
  assert.ok(lost, `expected figure-id-lost, got ${JSON.stringify(kinds(report))}`);
  assert.strictEqual(lost.level, 'breaking');
  assert.match(lost.detail, /omega/);
  assert.strictEqual(report.verdict, 'attention');
  assert.strictEqual(code, 20, 'an id-changing sheet must exit 20 so a schedule speaks up');
});

test('a sixth series is noticed when the sheet gains codes for it', () => {
  /*
   * The signal has to be one that only fires on something real. An earlier
   * version of the scan asked whether the row after the last checklist block
   * was occupied, and announced a new series on its first run — because the
   * sheet's Star Wars column carries on past Galaxy Peek into Widescreen,
   * Squish Squadron and the Grogu sets. A capsule row carrying series 6 is
   * the sheet actually saying so.
   */
  const rows = sheetFromShipped();
  const set = readJson('sw-galaxy-peek-s2.json');
  const four = set.figures.slice(0, 4).map((f) => toSheetName(f.name)).join(', ');
  const y = rows.length;
  put(rows, y, 3, 'bag');
  put(rows, y, 5, 'A001');
  put(rows, y, 6, 'Galaxy');
  put(rows, y, 8, '6');
  put(rows, y, 10, four);

  const { code, report } = runScan(toCsv(rows));
  const found = report.findings.find((f) => f.kind === 'series-in-codes');
  assert.ok(found, `expected series-in-codes, got ${JSON.stringify(kinds(report))}`);
  assert.match(found.detail, /Series 6/);
  assert.match(found.detail, /SERIES_COUNT/, 'the report must say what a person has to change');
  assert.strictEqual(code, 10);
});

test('the checklist running on past Galaxy Peek is not mistaken for a new series', () => {
  // The real sheet does exactly this, so the false positive is pinned here
  // rather than left to be rediscovered.
  const rows = sheetFromShipped();
  const start = build.FIRST_BLOCK_ROW + build.SERIES_COUNT * build.BLOCK_SIZE;
  for (const [i, name] of ['Ahsoka Tano', 'C-3PO', 'Chewbacca', 'Darth Vader'].entries()) {
    put(rows, start + i, build.NAME_COL, name);
    put(rows, start + i, build.RARITY_COL, 'Common');
  }
  const { code, report } = runScan(toCsv(rows));
  assert.deepStrictEqual(report.findings, [],
    `a longer Star Wars column is not a new series: ${JSON.stringify(kinds(report))}`);
  assert.strictEqual(code, 0);
});

test('a sheet whose shape has shifted is reported, not silently misread', () => {
  // Rows inserted above the checklist would slide every block down. The parser
  // throws rather than guessing, and the scan must surface that rather than
  // treating it as "no changes found".
  const rows = sheetFromShipped();
  rows.splice(build.FIRST_BLOCK_ROW, 0, [], []);

  const { code, report } = runScan(toCsv(rows));
  const broke = report.findings.find((f) => f.kind === 'sheet-shape-changed');
  assert.ok(broke, `expected sheet-shape-changed, got ${JSON.stringify(kinds(report))}`);
  assert.strictEqual(broke.level, 'breaking');
  assert.strictEqual(code, 20);
});

test('a corrected code is reported as safe to apply, not as a reason to stop', () => {
  /*
   * A code whose contents were corrected is the opposite of dangerous: until
   * it is applied, the app is confidently telling a child the wrong four
   * figures. Codes carry no progress, so nothing can be lost by taking it.
   * An earlier version graded this "breaking", which printed "do not rebuild"
   * over the one finding where rebuilding is the whole point.
   */
  const rows = sheetFromShipped();
  const set = readJson('sw-galaxy-peek-s2.json');
  const codes = JSON.parse(fs.readFileSync(path.join(SETS, 'codes-sw-galaxy-peek-s2.json'), 'utf8'));
  const [code, ids] = Object.entries(codes.codes)[0];
  const swapIn = set.figures.find((f) => !ids.includes(f.id));
  const replacement = [swapIn.id, ...ids.slice(1)]
    .map((id) => toSheetName(set.figures.find((f) => f.id === id).name)).join(', ');

  let touched = 0;
  for (const row of rows) {
    // The same code string exists in several series, so the series column has
    // to match too — rewriting all of them would name Series 2 figures inside
    // a Series 4 capsule, and the parser would rightly refuse it.
    if (row[5] === code && row[8] === '2') { row[10] = replacement; touched += 1; }
  }
  assert.strictEqual(touched, 1, `expected to rewrite exactly one row for ${code}`);

  const { code: exit, report, stdout } = runScan(toCsv(rows));
  const finding = report.findings.find((f) => f.kind === 'codes-changed');
  assert.ok(finding, `expected codes-changed, got ${JSON.stringify(kinds(report))}`);
  assert.match(finding.detail, new RegExp(code));
  assert.strictEqual(finding.level, 'additive',
    'a corrected code costs nothing to take; grading it breaking tells you to sit on a known-wrong answer');
  assert.doesNotMatch(stdout, /Do not rebuild/,
    'the advice must not tell you to withhold a correction');
  assert.strictEqual(exit, 10);
});

test('a code that collectors now disagree about is not passed over in silence', () => {
  /*
   * If somebody reports different contents for a code that already exists,
   * the builder stops calling it agreed and files it under `disputed` — the
   * app changes from naming four figures to saying it is not agreed on. That
   * is a visible change to what a child is told, so the scan has to mention
   * it. It was invisible at first: the diff skipped anything with more than
   * one variant, and a disputed code is still present, so it did not read as
   * withdrawn either.
   */
  const rows = sheetFromShipped();
  const set = readJson('sw-galaxy-peek-s2.json');
  const codes = JSON.parse(fs.readFileSync(path.join(SETS, 'codes-sw-galaxy-peek-s2.json'), 'utf8'));
  const [code, ids] = Object.entries(codes.codes)[0];
  const other = set.figures.find((f) => !ids.includes(f.id));
  const rival = [other.id, ...ids.slice(1)]
    .map((id) => toSheetName(set.figures.find((f) => f.id === id).name)).join(', ');

  const y = rows.length;
  put(rows, y, 3, 'bag');
  put(rows, y, 5, code);
  put(rows, y, 6, 'Galaxy');
  put(rows, y, 8, '2');
  put(rows, y, 10, rival);

  const { report } = runScan(toCsv(rows));
  const finding = report.findings.find((f) => f.kind === 'codes-disputed');
  assert.ok(finding, `expected codes-disputed, got ${JSON.stringify(kinds(report))}`);
  assert.match(finding.detail, new RegExp(code));
});

test('the scan never writes to sets/', () => {
  /*
   * The app's whole posture is that a confidently wrong checklist is worse
   * than none, so a scheduled job that rewrote a child's roster from a page
   * that changed overnight would be the worst possible feature. This pins the
   * tool as a reporter.
   */
  const before = fs.readdirSync(SETS).map((f) => {
    const s = fs.statSync(path.join(SETS, f));
    return `${f}:${s.size}:${s.mtimeMs}`;
  });
  const rows = sheetFromShipped();
  put(rows, rows.length, build.NAME_COL, 'ignored');
  runScan(toCsv(rows));
  const after = fs.readdirSync(SETS).map((f) => {
    const s = fs.statSync(path.join(SETS, f));
    return `${f}:${s.size}:${s.mtimeMs}`;
  });
  assert.deepStrictEqual(after, before, 'the scan modified sets/; it must only report');

  const src = fs.readFileSync(SCAN, 'utf8');
  assert.ok(!/writeFileSync\([^)]*SETS/.test(src),
    'scan_sources.cjs writes into sets/; it is a reporter, not a builder');
});
