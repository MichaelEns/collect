/*
 * "Which capsule should we buy next?"
 *
 * The collection screen answers "what has he got". This answers the question
 * that actually gets asked in a shop, which is a different one: you cannot buy
 * a figure, only a sealed capsule with a code moulded into the bottom. So the
 * useful output is a ranking of CODES by how many figures he still needs.
 *
 * It reads the same data the app does, rather than keeping its own copy:
 *
 *   - progress from localStorage under collect.progress.<setId>, the exact
 *     keys app.js writes and sync.js keeps up to date;
 *   - pictures from the same IndexedDB stores, so a figure he has photographed
 *     shows his photo and everything else shows the catalogue picture.
 *
 * That is why this is a page on the same origin rather than a file saved
 * somewhere: same origin means the same localStorage and the same IndexedDB,
 * with nothing to copy, export or fall out of step.
 *
 * It never WRITES progress. Ticking lives in the app, one tap away, and a
 * second writer would have to reimplement the timestamp rules sync depends on
 * — earning a whole class of "his tick vanished" bugs for no benefit.
 */
'use strict';

(function () {
  const PROGRESS_KEY = (setId) => `collect.progress.${setId}`;
  const WISHLIST_KEY = 'collect.wishlist';
  const DB_NAME = 'collect';
  const STORE = 'photos';
  const CAT_STORE = 'catalogue';

  const $ = (id) => document.getElementById(id);

  const state = {
    sets: [],
    filter: 'all',
    starring: false,
    wishlist: {},
    urls: [],
  };

  /* --------------------------------------------------------------- storage */

  function loadProgress(setId) {
    try {
      return JSON.parse(window.localStorage.getItem(PROGRESS_KEY(setId)) || '{}') || {};
    } catch { return {}; }
  }

  /*
   * The stars are this page's own idea and live only here.
   *
   * They are deliberately NOT pushed into the progress documents: the sync
   * merge sanitises every entry down to the fields it knows, so a star added
   * there would be silently dropped by the server — which looks exactly like
   * the app losing his work. Better a local list that is honest about being
   * local than a synced one that quietly is not.
   */
  function loadWishlist() {
    try {
      return JSON.parse(window.localStorage.getItem(WISHLIST_KEY) || '{}') || {};
    } catch { return {}; }
  }

  function saveWishlist() {
    try {
      window.localStorage.setItem(WISHLIST_KEY, JSON.stringify(state.wishlist));
    } catch { /* private mode: the screen is still right */ }
  }

  /*
   * The same database app.js uses, opened the same way.
   *
   * Version 2 with a conditional upgrade matches app.js exactly, so whichever
   * page a device happens to open first creates the same shape. Opening with a
   * lower version than exists throws, and opening with no version at all would
   * skip the upgrade and leave the stores missing on a fresh device.
   */
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
          if (!req.result.objectStoreNames.contains(CAT_STORE)) req.result.createObjectStore(CAT_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }).catch(() => null);
    }
    return dbPromise;
  }

  async function readImage(storeName, key) {
    const conn = await db();
    if (!conn || !conn.objectStoreNames.contains(storeName)) return null;
    return new Promise((resolve) => {
      let out = null;
      const tx = conn.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => resolve(out || null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  }

  /** His own photo wins; the catalogue picture is the fallback. Same order as the app. */
  async function pictureFor(setId, figureId) {
    const key = `${setId}/${figureId}`;
    return (await readImage(STORE, key)) || (await readImage(CAT_STORE, key));
  }

  /* ---------------------------------------------------------------- naming */

  const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  const baseName = (name) => String(name).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim()
    || String(name);
  const qualifierOf = (name) => (String(name).match(/\(([^)]*)\)/) || [])[1] || '';

  /* ----------------------------------------------------------------- data */

  async function getJson(url) {
    /*
     * Bounded, because a request that never settles would leave this page
     * blank for ever with nothing on screen to say why. The service worker
     * answers from its cache after its own network timeout, so offline this
     * legitimately takes a couple of seconds — the ceiling here only has to be
     * comfortably above that, not tight.
     */
    const response = await Promise.race([
      fetch(url),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${url} did not answer`)), 15000);
      }),
    ]);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  }

  async function load() {
    const index = await getJson('/collect/sets/index.json');

    /*
     * Everything at once, not one after another.
     *
     * This page needs every set and every code table — eleven files. Fetched
     * in a chain that is three round trips deep (index, then sets, then the
     * code file each set names), and offline every one of those waits out the
     * service worker before falling back to the cache: measured at four
     * seconds, which in a shop looks like a broken link.
     *
     * The index names the code file too, so the sets and the codes can be
     * asked for together. A set that somehow names a different one still
     * wins — the index is a shortcut, not a second source of truth.
     */
    const sets = await Promise.all(index.map(async (meta) => {
      const [set, guessedCodes] = await Promise.all([
        getJson(`/collect/sets/${meta.file}`),
        meta.codeFile
          ? getJson(`/collect/sets/${meta.codeFile}`).catch(() => null)
          : Promise.resolve(null),
      ]);

      let codes = guessedCodes;
      if (set.codeFile && set.codeFile !== meta.codeFile) {
        // A set without recorded codes is still worth showing: the pictures
        // and the count are useful even when nothing can be ranked.
        codes = await getJson(`/collect/sets/${set.codeFile}`).catch(() => null);
      }

      return {
        id: meta.id,
        name: set.name,
        emoji: set.emoji || '',
        packaging: set.packaging || '',
        rarities: set.rarities || [],
        figures: set.figures,
        codes: (codes && codes.codes) || {},
        progress: loadProgress(meta.id),
      };
    }));
    return sets;
  }

  const has = (set, figureId) => !!(set.progress[figureId] && set.progress[figureId].have);
  const starred = (setId, figureId) => !!state.wishlist[`${setId}/${figureId}`];

  const visibleSets = () => (state.filter === 'all'
    ? state.sets
    : state.sets.filter((s) => s.id === state.filter));

  /* -------------------------------------------------------------- painting */

  /**
   * Puts a picture into a slot that is already on screen.
   *
   * Object URLs are revoked once the browser has the pixels. Holding them would
   * leak one per figure on every redraw, and this redraws on every tap.
   */
  async function paint(slot, setId, figureId) {
    const blob = await pictureFor(setId, figureId);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => URL.revokeObjectURL(url);
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
    slot.innerHTML = '';
    slot.appendChild(img);
  }

  /*
   * What a slot shows before a picture arrives, and on a device that has none.
   *
   * Catalogue pictures live behind the family code, so a device that has not
   * synced them has nothing to draw — and a grid of empty grey squares reads
   * as broken rather than as "no picture yet". Two letters is what the app
   * itself falls back to. It does not need the app's collision handling here
   * because the full name is printed immediately beside it.
   */
  function initials(name) {
    const words = baseName(name).split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function renderSummary() {
    const sets = visibleSets();
    const total = sets.reduce((n, s) => n + s.figures.length, 0);
    const found = sets.reduce((n, s) => n + s.figures.filter((f) => has(s, f.id)).length, 0);
    const stars = sets.reduce((n, s) => n + s.figures.filter((f) => starred(s.id, f.id)).length, 0);

    $('hunt-summary').innerHTML = `
      <div id="progress-track"><div id="progress-fill" style="width:${total ? (found / total) * 100 : 0}%"></div></div>
      <p id="progress-text">${found} of ${total} found${stars ? ` · ${stars} starred` : ''}</p>
      <p class="sourced">Reading the same collection as the app. Tick things there;
        this page only reads.</p>`;
  }

  function renderSeriesFilter() {
    const select = $('hunt-series');
    if (select.options.length) return;
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All series';
    select.appendChild(all);
    for (const set of state.sets) {
      const option = document.createElement('option');
      option.value = set.id;
      option.textContent = `${set.emoji ? `${set.emoji} ` : ''}${set.name}`;
      select.appendChild(option);
    }
    select.value = state.filter;
  }

  /*
   * One card per distinct capsule, not per code.
   *
   * The same contents are sold under many codes — Series 1 has 276 codes but
   * only 21 distinct capsules, and one set of four figures carries 18 different
   * codes. Worse, the codes do not sit together: sorting puts "1" and "A001"
   * sixteen rows apart, so the same capsule reappears down the list looking
   * like a new find each time, and the top-40 cut could fill with repeats of
   * something he already decided against.
   *
   * Grouping is by exact contents within a series. Across series would be
   * wrong: a Series 1 capsule and a Series 3 capsule are different products
   * that happen to share figure ids.
   */
  function groupByContents(sets) {
    const groups = new Map();
    for (const set of sets) {
      const byId = new Map(set.figures.map((f) => [f.id, f]));
      for (const [code, ids] of Object.entries(set.codes)) {
        const figures = ids.map((id) => byId.get(id)).filter(Boolean);
        if (!figures.length) continue;
        // Sorted, so contents listed in a different order still count as the
        // same capsule. Not de-duplicated: a capsule holding two of the same
        // figure is genuinely a different capsule from one holding one.
        const key = `${set.id}\u0000${figures.map((f) => f.id).sort().join('|')}`;
        const found = groups.get(key);
        if (found) { found.codes.push(code); continue; }
        groups.set(key, { set, codes: [code], figures });
      }
    }
    return [...groups.values()];
  }

  /** Natural order, so A2 comes before A10 and bare numbers read as numbers. */
  const byCode = (a, b) => String(a).localeCompare(String(b), undefined, {
    numeric: true, sensitivity: 'base',
  });

  function renderBest() {
    const rows = [];
    for (const group of groupByContents(visibleSets())) {
      const missing = group.figures.filter((f) => !has(group.set, f.id));
      if (!missing.length) continue;
      const wanted = missing.filter((f) => starred(group.set.id, f.id)).length;
      group.codes.sort(byCode);
      rows.push({ ...group, missing, wanted });
    }

    /*
     * Starred first, then sheer number of new figures. "Most new" and "the one
     * he actually wants" are different questions, and when he has starred
     * something the second one is the one being asked.
     */
    rows.sort((a, b) => b.wanted - a.wanted
      || b.missing.length - a.missing.length
      || byCode(a.codes[0], b.codes[0]));

    const host = $('hunt-best');
    host.innerHTML = '';

    if (!rows.length) {
      const p = document.createElement('p');
      p.className = 'caveat';
      p.textContent = visibleSets().some((s) => Object.keys(s.codes).length)
        ? 'Every capsule we know the contents of holds only figures already found. '
          + 'Nothing left to hunt here.'
        : 'No capsule codes have been recorded for this series yet, so there is '
          + 'nothing to rank.';
      host.appendChild(p);
      return;
    }

    const shown = rows.slice(0, 40);
    for (const row of shown) {
      const card = document.createElement('article');
      card.className = 'hunt-row';

      const head = document.createElement('div');
      head.className = 'hunt-row-head';
      head.innerHTML = `
        <span class="hunt-adds">${row.missing.length} new${row.wanted ? ` · ${row.wanted}★` : ''}</span>
        <span class="hunt-series-name">${escapeHtml(row.set.name.replace('Galaxy Peek ', ''))}</span>`;
      card.appendChild(head);

      /*
       * Every code, never a "+3 more". The list IS the instruction — he is
       * standing at a shelf checking whether the code in his hand is one of
       * these, and a hidden one is a capsule he puts back for no reason.
       */
      const codes = document.createElement('div');
      codes.className = 'hunt-codes';
      codes.setAttribute('aria-label', row.codes.length > 1
        ? `Any of these ${row.codes.length} codes`
        : 'Capsule code');
      if (row.codes.length > 1) {
        const note = document.createElement('span');
        note.className = 'hunt-codes-note';
        note.textContent = `any of these ${row.codes.length}:`;
        codes.appendChild(note);
      }
      for (const code of row.codes) {
        const chip = document.createElement('span');
        chip.className = 'hunt-code';
        chip.textContent = code;
        codes.appendChild(chip);
      }
      card.appendChild(codes);

      const inside = document.createElement('div');
      inside.className = 'hunt-inside';
      for (const figure of row.figures) {
        const got = has(row.set, figure.id);
        const item = document.createElement('div');
        item.className = 'hunt-fig' + (got ? ' got' : '');
        const slot = document.createElement('span');
        slot.className = 'hunt-pic';
        slot.textContent = got ? '✓' : initials(figure.name);
        const label = document.createElement('span');
        label.className = 'hunt-fig-name';
        label.textContent = figure.name + (starred(row.set.id, figure.id) ? ' ★' : '');
        item.appendChild(slot);
        item.appendChild(label);
        inside.appendChild(item);
        paint(slot, row.set.id, figure.id);
      }
      card.appendChild(inside);
      host.appendChild(card);
    }

    if (rows.length > shown.length) {
      const more = document.createElement('p');
      more.className = 'caveat';
      more.textContent = `Showing the best ${shown.length} of ${rows.length} capsules `
        + 'that would add something.';
      host.appendChild(more);
    }
  }

  function renderGrid() {
    const host = $('hunt-grid');
    host.innerHTML = '';
    $('hunt-grid-hint').textContent = state.starring
      ? 'Tap anyone to star them.'
      : 'A tick means he has it already.';

    for (const set of visibleSets()) {
      const heading = document.createElement('h3');
      heading.className = 'hunt-set-name';
      heading.textContent = `${set.emoji ? `${set.emoji} ` : ''}${set.name}`;
      host.appendChild(heading);

      const grid = document.createElement('div');
      grid.className = 'grid';
      for (const figure of set.figures) {
        const got = has(set, figure.id);
        const star = starred(set.id, figure.id);
        const card = document.createElement(state.starring ? 'button' : 'div');
        if (state.starring) card.type = 'button';
        card.className = 'fig' + (got ? ' have' : '') + (star ? ' starred' : '');
        const qualifier = qualifierOf(figure.name);
        const rarity = (set.rarities || []).find((r) => r.id === figure.rarity);
        card.innerHTML = `
          ${got ? '<span class="fig-tick">✓</span>' : ''}
          ${star ? '<span class="fig-star">★</span>' : ''}
          <span class="fig-art" data-slot="${escapeHtml(set.id)}/${escapeHtml(figure.id)}">${escapeHtml(initials(figure.name))}</span>
          <span class="fig-name">${escapeHtml(baseName(figure.name))}</span>
          ${qualifier ? `<span class="fig-qual">${escapeHtml(qualifier)}</span>` : ''}
          <span class="rarity-dot" style="background:${rarity ? escapeHtml(rarity.colour) : 'var(--line)'}"></span>`;
        if (state.starring) {
          card.addEventListener('click', () => {
            const key = `${set.id}/${figure.id}`;
            if (state.wishlist[key]) delete state.wishlist[key];
            else state.wishlist[key] = true;
            saveWishlist();
            render();
          });
        }
        grid.appendChild(card);
        paint(card.querySelector('.fig-art'), set.id, figure.id);
      }
      host.appendChild(grid);
    }
  }

  function render() {
    renderSummary();
    renderSeriesFilter();
    renderBest();
    renderGrid();
    $('hunt-mode').textContent = state.starring ? 'Done starring' : 'Star the ones he wants';
    $('hunt-mode-hint').hidden = !state.starring;
  }

  /* ------------------------------------------------------------------ boot */

  function setFromHash() {
    const m = /set=([a-z0-9-]+)/i.exec(window.location.hash || '');
    return m ? m[1] : 'all';
  }

  async function start() {
    state.wishlist = loadWishlist();
    /*
     * Say something immediately. Offline the sets come from the service
     * worker's cache only after its network timeout, so there is a real
     * second or two where a silent page looks like a broken link.
     */
    $('hunt-best').innerHTML = '<p class="caveat">Working out what to hunt…</p>';
    const began = Date.now();
    try {
      state.sets = await load();
    } catch (err) {
      $('hunt-best').innerHTML = '<p class="caveat">The collection could not be '
        + 'loaded. Open the app once while online, then come back.</p>';
      return;
    }
    state.loadMs = Date.now() - began;
    const wanted = setFromHash();
    state.filter = state.sets.some((s) => s.id === wanted) ? wanted : 'all';
    render();
  }

  $('hunt-series').addEventListener('change', (event) => {
    state.filter = event.target.value;
    render();
  });

  $('hunt-mode').addEventListener('click', () => {
    state.starring = !state.starring;
    render();
  });

  /*
   * Coming back to this page is the moment the app may have been used in
   * between — a tick made on the collection screen should be reflected here
   * rather than needing a reload.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.sets.length) return;
    for (const set of state.sets) set.progress = loadProgress(set.id);
    render();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/collect/sw.js').catch(() => { /* offline is a bonus */ });
    });
  }

  window.__hunt = { state, render, loadProgress };

  start();
}());
