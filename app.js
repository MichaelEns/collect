/*
 * A collection tracker for mystery-box figures.
 *
 * Two things shaped this beyond the usual:
 *
 *  - The artwork is the child's own. Official product photography belongs to
 *    the manufacturer and cannot be redistributed, so instead of shipping
 *    borrowed images the app lets him photograph the figure he actually found.
 *    It is legally clean, and a shelf of his own photos beats a catalogue.
 *
 *  - Where the data is not certain, the app says so. Community-sourced
 *    rosters and packaging codes are marked, because a child will believe a
 *    checklist, and a confidently wrong one is worse than none.
 */
'use strict';

(function () {
  const PROGRESS_KEY = (setId) => `collect.progress.${setId}`;
  const DB_NAME = 'collect';
  const STORE = 'photos';
  const CAT_STORE = 'catalogue';
  const PHOTO_MAX_PX = 480;

  const $ = (id) => document.getElementById(id);

  const state = {
    index: [],
    set: null,
    codes: null,
    tags: null,
    progress: {},
    figure: null,
    photoUrl: null,
  };

  /* --------------------------------------------------------------- storage */

  function loadProgress(setId) {
    try {
      return JSON.parse(window.localStorage.getItem(PROGRESS_KEY(setId)) || '{}') || {};
    } catch { return {}; }
  }

  function saveProgress() {
    if (!state.set) return;
    try {
      window.localStorage.setItem(PROGRESS_KEY(state.set.id), JSON.stringify(state.progress));
    } catch { /* private mode, or full: the screen is still right */ }
  }

  const entry = (figureId) => state.progress[figureId] || { have: false, dupes: 0, codes: [] };

  /**
   * Writes an entry back, filling in anything an older saved shape lacked.
   *
   * Every write is stamped. Sync merges per figure and newest wins, so without
   * a timestamp an edit made here could lose to a stale one from another
   * device. Entries saved before sync existed have no stamp, which reads as
   * zero — so any real edit beats them, which is what we want.
   */
  function setEntry(figureId, changes) {
    const current = entry(figureId);
    state.progress[figureId] = {
      have: current.have,
      dupes: current.dupes || 0,
      codes: current.codes || [],
      ...changes,
      updatedAt: Date.now(),
    };
    saveProgress();
    document.dispatchEvent(new CustomEvent('collect:changed'));
  }

  /* ---------------------------------------------------------------- photos */

  /*
   * Photos go in IndexedDB rather than localStorage. localStorage holds
   * strings and caps out around 5MB, so a handful of base64 photos would fill
   * it and start throwing — taking the progress data down with them.
   *
   * Two stores, not one with prefixed keys. A catalogue picture shows what a
   * figure looks like before it is found; his own photo replaces it after. They
   * therefore coexist for the same figure, and more importantly sync walks
   * every key in a store — sharing one would upload catalogue pictures as if a
   * child had taken them.
   */
  let dbPromise = null;

  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        // v2 added the catalogue store. Both are created conditionally so a
        // fresh install and an upgrade from v1 take the same path.
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

  async function storeOp(storeName, mode, run) {
    const conn = await db();
    if (!conn) return null;
    return new Promise((resolve) => {
      let out = null;
      const tx = conn.transaction(storeName, mode);
      const req = run(tx.objectStore(storeName));
      if (req) req.onsuccess = () => { out = req.result; };
      tx.oncomplete = () => resolve(out);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    });
  }

  const photoOp = (mode, run) => storeOp(STORE, mode, run);
  const catOp = (mode, run) => storeOp(CAT_STORE, mode, run);

  const photoKey = (figureId) => `${state.set.id}/${figureId}`;
  const getPhoto = (key) => photoOp('readonly', (s) => s.get(key));
  const putPhoto = (key, blob) => photoOp('readwrite', (s) => s.put(blob, key));
  const delPhoto = (key) => photoOp('readwrite', (s) => s.delete(key));
  const photoKeys = () => photoOp('readonly', (s) => s.getAllKeys());

  const getCatalogue = (key) => catOp('readonly', (s) => s.get(key));
  const putCatalogue = (key, blob) => catOp('readwrite', (s) => s.put(blob, key));
  const delCatalogue = (key) => catOp('readwrite', (s) => s.delete(key));
  const catalogueKeys = () => catOp('readonly', (s) => s.getAllKeys());

  /**
   * Shrinks a camera photo before storing it. A modern phone photo is several
   * megabytes; at 480px it is a few tens of kilobytes and still far more than
   * a 62px card ever shows.
   */
  async function shrink(file) {
    const draw = (source, w, h) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(source, 0, 0, w, h);
      return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
    };
    const scaled = (w, h) => {
      const scale = Math.min(1, PHOTO_MAX_PX / Math.max(w, h));
      return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
    };

    try {
      const bitmap = await createImageBitmap(file);
      const [w, h] = scaled(bitmap.width, bitmap.height);
      const blob = await draw(bitmap, w, h);
      bitmap.close();
      return blob || file;
    } catch {
      // Older Safari has no createImageBitmap; an <img> gets there too.
      return new Promise((resolve) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = async () => {
          const [w, h] = scaled(img.naturalWidth, img.naturalHeight);
          const blob = await draw(img, w, h);
          URL.revokeObjectURL(url);
          resolve(blob || file);
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
      });
    }
  }

  /* -------------------------------------------------------------- confetti */

  const canvas = $('fx');
  const ctx = canvas.getContext('2d');
  const COLOURS = ['#ffc93d', '#43d17c', '#7ee8ff', '#c78dff', '#ff6b8a', '#ffffff'];
  let bits = [];
  let spinning = false;

  function sizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function burst(count) {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let i = 0; i < count; i += 1) {
      const fromLeft = i % 2 === 0;
      const angle = (fromLeft ? -1 : 1) * (Math.PI / 3) * Math.random() - Math.PI / 3;
      const speed = 260 + Math.random() * 520;
      bits.push({
        x: fromLeft ? w * 0.04 : w * 0.96,
        y: h * 0.96,
        vx: Math.cos(angle) * speed * (fromLeft ? 1 : -1),
        vy: Math.sin(angle) * speed - 260,
        w: 7 + Math.random() * 7,
        h: 10 + Math.random() * 10,
        rot: Math.random() * Math.PI,
        vrot: (Math.random() - 0.5) * 14,
        colour: COLOURS[(Math.random() * COLOURS.length) | 0],
        life: 0,
      });
    }
    if (!spinning) { spinning = true; last = performance.now(); requestAnimationFrame(spin); }
  }

  let last = 0;
  function spin(now) {
    const dt = Math.min((now - last) / 1000 || 0, 0.05);
    last = now;
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (let i = bits.length - 1; i >= 0; i -= 1) {
      const b = bits[i];
      b.life += dt;
      b.vy += 900 * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.rot += b.vrot * dt;
      if (b.life > 3.4 || b.y > window.innerHeight + 60) { bits.splice(i, 1); continue; }
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, (3.4 - b.life) / 0.6));
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.colour;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (bits.length) { requestAnimationFrame(spin); } else { spinning = false; }
  }

  function cheer(message) {
    const el = $('cheer');
    el.textContent = message;
    el.hidden = false;
    burst(90);
    setTimeout(() => burst(60), 400);
    setTimeout(() => { el.hidden = true; }, 3200);
  }

  /* -------------------------------------------------------------- rendering */

  function rarityOf(figure) {
    if (!figure.rarity || !state.set.rarities) return null;
    return state.set.rarities.find((r) => r.id === figure.rarity) || null;
  }

  /*
   * The short tag on a figure's tile, for figures with no photo yet.
   *
   * First letters of the first two words is not enough on this data. Single
   * word names collapse to ONE letter, so Yoda and Yaddle both read "Y" and
   * Bossk, Blurrg and Bantha all read "B"; splitting on spaces alone turns
   * every astromech into "R"; and the two Anakins in Series 2 differ only in
   * a bracket the tile threw away. Every one of the five sets had collisions.
   *
   * So each name offers candidates from most to least compact, and the set
   * decides. Names whose first choice is already unique keep it, which is
   * almost all of them.
   */
  function tagCandidates(name) {
    const raw = String(name).trim();
    const qualifier = (raw.match(/\(([^)]*)\)/) || [])[1] || '';
    const tokens = raw.replace(/\([^)]*\)/g, ' ').split(/[^A-Za-z0-9]+/).filter(Boolean);
    const out = [];
    const push = (value) => {
      const tag = String(value || '').toUpperCase();
      if (tag && !out.includes(tag)) out.push(tag);
    };

    if (!tokens.length) {
      push(raw.slice(0, 2));
      return out.length ? out : ['?'];
    }

    if (/\d/.test(tokens[0])) {
      // R2-D2, R4-P17, K-2SO: the leading chunk is how the name is said out
      // loud, so "R4" beats "RA" and keeps the two R4 droids apart at three.
      // 4-Lom's leading chunk is a single digit, so it borrows the next word
      // rather than shipping a one-character tile.
      const head = tokens[0].length >= 2 || !tokens[1]
        ? tokens[0].slice(0, 2)
        : tokens[0] + tokens[1][0];
      push(head);
      if (tokens[1]) push(head + tokens[1][0]);
    } else if (tokens.length > 1) {
      push(tokens[0][0] + tokens[1][0]);
      if (tokens[2]) push(tokens[0][0] + tokens[1][0] + tokens[2][0]);
      if (qualifier) push(tokens[0][0] + tokens[1][0] + qualifier[0]);
      push(tokens[0].slice(0, 2) + tokens[1][0]);
    } else {
      push(tokens[0].slice(0, 2));
      push(tokens[0].slice(0, 3));
    }
    if (qualifier) push(out[0] + qualifier[0]);
    push(raw.replace(/[^A-Za-z0-9]/g, '').slice(0, 3));
    return out;
  }

  /**
   * Picks one tag per figure so that no two in the same set match. Where two
   * figures want the same tag BOTH lengthen, rather than the first one winning
   * and the second looking like the odd one out — except when one of them is a
   * bracketed variant of the other, where the plain name keeps the short tag.
   */
  function assignTags(figures) {
    const candidates = new Map(figures.map((f) => [f.id, tagCandidates(f.name)]));
    const groups = new Map();
    for (const figure of figures) {
      const first = candidates.get(figure.id)[0];
      if (!groups.has(first)) groups.set(first, []);
      groups.get(first).push(figure);
    }

    const tags = new Map();
    const used = new Set();
    const contested = [];
    for (const [first, members] of groups) {
      if (members.length === 1) {
        tags.set(members[0].id, first);
        used.add(first);
        continue;
      }
      // "Princess Leia" keeps PL and the hologram becomes PLH. Making both
      // lengthen would give PRL and PLH, which is worse for the common one.
      const plain = members.filter((f) => !qualifierOf(f.name));
      if (plain.length === 1) {
        tags.set(plain[0].id, first);
        used.add(first);
        for (const f of members) if (f !== plain[0]) contested.push(f);
      } else {
        contested.push(...members);
      }
    }

    for (const figure of contested) {
      const options = candidates.get(figure.id);
      let pick = options.find((tag, i) => i > 0 && !used.has(tag))
        || options.find((tag) => !used.has(tag));
      if (!pick) {
        // Nothing left to try. Numbering is ugly but it is still readable, and
        // it beats two tiles a child cannot tell apart.
        let n = 2;
        while (used.has(options[0] + n)) n += 1;
        pick = options[0] + n;
      }
      used.add(pick);
      tags.set(figure.id, pick);
    }
    return tags;
  }

  /** The bracketed part of a name, which is the only thing telling some pairs apart. */
  function qualifierOf(name) {
    return (String(name).match(/\(([^)]*)\)/) || [])[1] || '';
  }

  /** The name without its bracket, since the bracket is shown separately. */
  function baseName(name) {
    return String(name).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim() || String(name);
  }

  function renderPicker() {
    const list = $('set-list');
    list.innerHTML = '';
    for (const meta of state.index) {
      const progress = loadProgress(meta.id);
      const have = Object.values(progress).filter((p) => p && p.have).length;
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'set-card';
      button.innerHTML = `
        <span class="set-badge">${escapeHtml(meta.emoji || '📦')}</span>
        <span class="set-card-body">
          <h2>${escapeHtml(meta.name)}</h2>
          <p>${escapeHtml(meta.brand)}${meta.packaging ? ' · ' + escapeHtml(meta.packaging) : ''}</p>
        </span>
        <span class="set-card-count">${have}/${meta.total}</span>`;
      button.addEventListener('click', () => { location.hash = '#set=' + meta.id; });
      li.appendChild(button);
      list.appendChild(li);
    }
    $('picker-empty').hidden = state.index.length > 0;
  }

  function renderCollection() {
    const set = state.set;
    $('title').textContent = set.name;
    $('subtitle').textContent = set.brand + (set.packaging ? ' · ' + set.packaging : '');

    const total = set.figures.length;
    const have = set.figures.filter((f) => entry(f.id).have).length;
    $('progress-fill').style.width = total ? `${(have / total) * 100}%` : '0%';
    $('progress-text').textContent = have === total && total
      ? `All ${total} found!`
      : `${have} of ${total} found`;

    const sourced = $('sourced');
    sourced.innerHTML = '';
    // The caveats matter as much as the roster: what the capsule looks like,
    // whether there may be more figures than we know, and how firm the rarity
    // is. They belong on screen, not only in the data file.
    const caveats = [set.packagingNote, set.countNote, set.rarityNote].filter(Boolean);
    for (const text of caveats) {
      const p = document.createElement('p');
      p.className = 'caveat';
      p.textContent = text;
      sourced.appendChild(p);
    }
    if (set.sourced) {
      const p = document.createElement('p');
      p.appendChild(document.createTextNode(set.sourced));
      if (set.official) {
        p.appendChild(document.createTextNode(' '));
        const a = document.createElement('a');
        a.href = set.official;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = 'Official page ↗';
        p.appendChild(a);
      }
      sourced.appendChild(p);
    }

    const grid = $('grid');
    grid.innerHTML = '';
    const tags = assignTags(set.figures);
    state.tags = tags;
    for (const figure of set.figures) {
      const got = entry(figure.id);
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'fig' + (got.have ? ' have' : '') + (figure.verified === false ? ' unverified' : '');
      card.dataset.figure = figure.id;
      const rarity = rarityOf(figure);
      const qualifier = qualifierOf(figure.name);
      card.innerHTML = `
        <span class="fig-tick">✓</span>
        ${got.dupes > 0 ? `<span class="fig-dupe">+${got.dupes}</span>` : ''}
        <span class="fig-art" data-art="${escapeHtml(figure.id)}">${escapeHtml(tags.get(figure.id))}</span>
        <span class="fig-name">${escapeHtml(baseName(figure.name))}</span>
        ${qualifier ? `<span class="fig-qual">${escapeHtml(qualifier)}</span>` : ''}
        <span class="rarity-dot" style="background:${rarity ? escapeHtml(rarity.colour) : 'var(--line)'}"></span>`;
      card.addEventListener('click', () => openSheet(figure));
      grid.appendChild(card);
      paintArt(figure.id);
    }

    const bits = [];
    if (set.rarities) bits.push(set.rarities.map((r) => r.label).join(' · '));
    if (set.figures.some((f) => f.verified === false)) {
      bits.push('A “?” marks an entry we could not confirm against an official list.');
    }
    $('legend').textContent = bits.join(' — ');

    // Carry the set through, so the hunt page opens on the series he was just
    // looking at rather than all five at once.
    $('hunt-link').href = `/collect/hunt.html#set=${encodeURIComponent(set.id)}`;
  }

  /*
   * Puts a picture on a card, if there is one to put.
   *
   *   his own photo  >  catalogue picture  >  the letter tag
   *
   * The catalogue picture is what a figure looks like before it is found, so he
   * knows what he is hunting; his own photo takes over the moment he finds one.
   * The tag stays underneath both and is what shows when there is no picture at
   * all, which is why it still has to be unique.
   */
  async function paintArt(figureId) {
    const key = photoKey(figureId);
    const blob = (await getPhoto(key)) || (await getCatalogue(key));
    if (!blob) return;
    const holder = document.querySelector(`.fig-art[data-art="${CSS.escape(figureId)}"]`);
    if (!holder) return;
    const img = document.createElement('img');
    img.alt = '';
    img.src = URL.createObjectURL(blob);
    // Revoked once the browser has the pixels; holding it leaks a URL per card
    // on every re-render, and this re-renders on every tap.
    img.onload = () => URL.revokeObjectURL(img.src);
    holder.innerHTML = '';
    holder.appendChild(img);
  }

  /* ----------------------------------------------------------------- sheet */

  async function openSheet(figure) {
    state.figure = figure;
    const got = entry(figure.id);

    $('sheet-name').textContent = figure.name;
    $('sheet-placeholder').textContent = (state.tags && state.tags.get(figure.id))
      || tagCandidates(figure.name)[0];

    const rarity = rarityOf(figure);
    const rarityEl = $('sheet-rarity');
    rarityEl.hidden = !rarity;
    if (rarity) {
      rarityEl.textContent = rarity.label;
      rarityEl.style.background = rarity.colour;
      rarityEl.style.color = '#101010';
    }

    const noteEl = $('sheet-note');
    const note = figure.note || (figure.verified === false
      ? 'We could not confirm this one against an official list, so it might not be right.'
      : '');
    noteEl.hidden = !note;
    noteEl.textContent = note;

    const numberEl = $('sheet-number');
    numberEl.hidden = !figure.number;
    if (figure.number) {
      numberEl.textContent = `${state.set.numberLabel || '#'} ${figure.number}`;
      numberEl.title = state.set.numberNote || '';
    }

    /*
     * Codes are the child's own findings, and — where the community has worked
     * them out — a shipped lookup as well.
     *
     * The codes do differ between production batches: the letter at the front
     * of the code IS the batch. That was once the reason not to ship them at
     * all, which was an overcorrection. Collectors have mapped the batches, so
     * the lookup keys on the whole code and is right for every batch it knows.
     * Where contributors disagreed about a code the app says so rather than
     * picking a side, and a code it has never seen is reported as unknown
     * rather than guessed. Anything moulded on a capsule he opens still goes
     * in by hand.
     */
    renderCodes();
    renderKnownCodes();
    $('code-note').textContent = state.set.codeNote || '';
    $('code-note').hidden = !state.set.codeNote;

    const credit = $('code-credit');
    const source = state.codes && state.codes.source;
    credit.hidden = !source;
    if (source) credit.textContent = `Codes worked out and shared by ${source.credit}.`;

    const codeLink = $('code-link');
    codeLink.hidden = !state.set.codeLink;
    if (state.set.codeLink) {
      codeLink.href = state.set.codeLink;
      codeLink.textContent = (state.set.codeLinkLabel || 'Community code list') + ' ↗';
    }

    const official = $('sheet-official');
    const link = figure.official || state.set.official;
    official.hidden = !link;
    if (link) official.href = link;

    renderSheetState();
    await showSheetPhoto();
    $('sheet').hidden = false;
  }

  function renderCodes() {
    const list = $('code-list');
    list.innerHTML = '';
    const codes = entry(state.figure.id).codes || [];
    for (const code of codes) {
      const li = document.createElement('li');
      li.textContent = code;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'code-remove';
      remove.setAttribute('aria-label', `Forget the code ${code}`);
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        setEntry(state.figure.id, { codes: codes.filter((c) => c !== code) });
        renderCodes();
      });
      li.appendChild(remove);
      list.appendChild(li);
    }
    if (!codes.length) {
      const li = document.createElement('li');
      li.className = 'code-empty';
      li.textContent = 'none written down yet';
      list.appendChild(li);
    }
  }

  $('code-add').addEventListener('click', () => {
    const raw = window.prompt(
      'What code is pressed into the bottom of the capsule?\n(Something like P02)'
    );
    if (!raw || !raw.trim()) return;
    // Folded to upper case with the spaces taken out, so the same code typed
    // twice in slightly different ways does not become two entries.
    const code = raw.trim().toUpperCase().replace(/\s+/g, '');
    const codes = entry(state.figure.id).codes || [];
    if (!codes.includes(code)) setEntry(state.figure.id, { codes: codes.concat(code) });
    renderCodes();
  });

  /* ----------------------------------------------------------- capsule codes */

  /** Same folding on the way in and on lookup, so O and 0 cannot diverge. */
  function normaliseCode(raw) {
    return String(raw || '').trim().toUpperCase().replace(/[\s\-_.]+/g, '');
  }

  const figureById = (id) => (state.set ? state.set.figures.find((f) => f.id === id) : null);

  /**
   * What do we know about this code?
   *
   * Returns one of:
   *   { status: 'agreed',   figures }  every contributor listed the same four
   *   { status: 'disputed', variants } contributors disagreed; all are shown
   *   { status: 'unknown' }            nobody has recorded this one
   */
  function lookupCode(raw) {
    const code = normaliseCode(raw);
    if (!code || !state.codes) return { status: 'unknown', code };
    const agreed = state.codes.codes || {};
    if (agreed[code]) {
      return { status: 'agreed', code, figures: agreed[code].map(figureById).filter(Boolean) };
    }
    const disputed = (state.codes.disputed || {})[code];
    if (disputed) {
      return {
        status: 'disputed',
        code,
        variants: disputed.map((ids) => ids.map(figureById).filter(Boolean)),
      };
    }
    return { status: 'unknown', code };
  }

  /** Every known code whose capsule contains this figure. */
  function codesContaining(figureId) {
    if (!state.codes) return [];
    return Object.entries(state.codes.codes || {})
      .filter(([, ids]) => ids.includes(figureId))
      .map(([code]) => code)
      .sort();
  }

  function figureChip(figure) {
    const got = entry(figure.id);
    const rarity = rarityOf(figure);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (got.have ? ' have' : ' want');
    chip.innerHTML = `
      <span class="chip-mark">${got.have ? '✓' : '★'}</span>
      <span class="chip-name">${escapeHtml(figure.name)}</span>
      <span class="rarity-dot" style="background:${rarity ? escapeHtml(rarity.colour) : 'var(--line)'}"></span>`;
    chip.addEventListener('click', () => openSheet(figure));
    return chip;
  }

  function renderCodeResult(raw) {
    const box = $('code-result');
    box.innerHTML = '';
    const typed = normaliseCode(raw);
    $('code-clear').hidden = !typed;
    if (!typed) return;

    const found = lookupCode(typed);
    const say = (className, text) => {
      const p = document.createElement('p');
      p.className = className;
      p.textContent = text;
      box.appendChild(p);
      return p;
    };

    if (found.status === 'unknown') {
      say('finder-verdict unknown', `We do not know code ${typed}.`);
      say('finder-sub', 'Nobody has written this one down yet. Open it, then add'
        + ' the code to whichever figures were inside — that makes it yours.');
      return;
    }

    const lists = found.status === 'agreed' ? [found.figures] : found.variants;

    if (found.status === 'agreed') {
      const missing = found.figures.filter((f) => !entry(f.id).have);
      // The verdict answers the question actually being asked, which is
      // whether to buy this capsule — not merely what is in it.
      if (!found.figures.length) {
        say('finder-verdict unknown', `We do not know code ${typed}.`);
        return;
      }
      if (missing.length === 0) {
        // "all four" was fine while every set was a four-figure capsule.
        // A Galactic Cruisers pack holds one figure and one vehicle, so the
        // wording follows the data rather than assuming a size.
        say('finder-verdict got', found.figures.length === 1
          ? 'You already have this one.'
          : `You already have all ${found.figures.length} of these.`);
      } else {
        say('finder-verdict want', missing.length === 1
          ? 'This one has 1 you still need!'
          : `This one has ${missing.length} you still need!`);
      }
    } else {
      say('finder-verdict disputed', `Code ${typed} is not agreed on.`);
      say('finder-sub', 'Collectors have reported different figures for this'
        + ' code, so it could be any of these. Both are shown rather than'
        + ' guessing at one.');
    }

    for (const [i, figures] of lists.entries()) {
      if (lists.length > 1) {
        const h = document.createElement('p');
        h.className = 'finder-sub';
        const what = figures.length === 1 ? 'this' : `these ${figures.length}`;
        h.textContent = i === 0 ? `Someone found ${what}:` : `Someone else found ${what}:`;
        box.appendChild(h);
      }
      const row = document.createElement('div');
      row.className = 'chip-row';
      for (const f of figures) row.appendChild(figureChip(f));
      box.appendChild(row);
    }
  }

  function renderFinder() {
    const finder = $('finder');
    const count = state.codes ? Object.keys(state.codes.codes || {}).length : 0;
    finder.hidden = count === 0;
    if (!count) return;
    const batches = Object.keys(state.codes.batches || {}).length;
    $('finder-hint').textContent = `Type the code moulded into the bottom of the`
      + ` capsule and we will tell you what is inside. We know ${count} codes`
      + `${batches ? ` across ${batches} batches` : ''}.`;
    $('code-input').value = '';
    renderCodeResult('');
  }

  function renderKnownCodes() {
    const wrap = $('known-codes');
    const list = $('known-code-list');
    const more = $('known-code-more');
    list.innerHTML = '';
    const codes = codesContaining(state.figure.id);
    wrap.hidden = codes.length === 0;
    if (!codes.length) return;

    /*
     * Every code, never a "…and 28 more".
     *
     * This was capped at twelve to stop it becoming a wall of text. That was
     * the wrong trade: the list exists to be checked against a capsule in his
     * hand, and a truncated list quietly answers "no" for the codes it hid.
     *
     * Grouping by batch letter is what makes the full list readable — the
     * leading letter is the batch, so the code in his hand is inside exactly
     * one of these rows and he only has to scan that one.
     */
    const byBatch = new Map();
    for (const code of codes) {
      const letter = (code.match(/^[A-Z]+/) || ['#'])[0];
      if (!byBatch.has(letter)) byBatch.set(letter, []);
      byBatch.get(letter).push(code);
    }

    for (const [letter, group] of [...byBatch].sort((a, b) => a[0].localeCompare(b[0]))) {
      const row = document.createElement('li');
      row.className = 'known-batch';
      const tag = document.createElement('span');
      tag.className = 'batch-tag';
      tag.textContent = letter === '#' ? 'no letter' : `batch ${letter}`;
      row.appendChild(tag);
      const codesWrap = document.createElement('span');
      codesWrap.className = 'batch-codes';
      for (const code of group) {
        const chip = document.createElement('span');
        chip.className = 'known-code';
        chip.textContent = code;
        codesWrap.appendChild(chip);
      }
      row.appendChild(codesWrap);
      list.appendChild(row);
    }

    more.textContent = codes.length === 1
      ? 'That is the only capsule we know of with this one inside.'
      : `${codes.length} capsules in ${byBatch.size} `
        + `${byBatch.size === 1 ? 'batch' : 'batches'} have this one inside.`;
  }

  $('code-input').addEventListener('input', (event) => {
    renderCodeResult(event.target.value);
  });

  $('code-clear').addEventListener('click', () => {
    $('code-input').value = '';
    renderCodeResult('');
    $('code-input').focus();
  });

  function renderSheetState() {
    const got = entry(state.figure.id);
    const have = $('sheet-have');
    have.textContent = got.have ? 'Take it off the list' : 'I found it!';
    have.classList.toggle('undo', got.have);
    $('dupe-count').textContent = String(got.dupes);
  }

  async function showSheetPhoto() {
    if (state.photoUrl) { URL.revokeObjectURL(state.photoUrl); state.photoUrl = null; }
    const key = photoKey(state.figure.id);
    const own = await getPhoto(key);
    const blob = own || (await getCatalogue(key));
    const img = $('sheet-photo');
    if (blob) {
      state.photoUrl = URL.createObjectURL(blob);
      img.src = state.photoUrl;
      img.hidden = false;
      $('sheet-placeholder').hidden = true;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      $('sheet-placeholder').hidden = false;
    }
    /*
     * The buttons talk about HIS photo only. A catalogue picture is not his to
     * remove, and while one is showing he still has not taken his own — so the
     * prompt has to stay "add", not become "take a different one".
     */
    $('photo-remove').hidden = !own;
    $('photo-button-text').textContent = own
      ? '📷 Take a different photo'
      : '📷 Add a photo of yours';
  }

  function closeSheet() {
    $('sheet').hidden = true;
    if (state.photoUrl) { URL.revokeObjectURL(state.photoUrl); state.photoUrl = null; }
    state.figure = null;
  }

  function setHave(figureId, have) {
    const got = entry(figureId);
    // Codes survive un-marking: they describe the capsule, not the ownership,
    // and losing hard-won findings to a mis-tap would be its own small tragedy.
    setEntry(figureId, { have, dupes: have ? got.dupes : 0 });

    const total = state.set.figures.length;
    const found = state.set.figures.filter((f) => entry(f.id).have).length;
    renderCollection();
    // The verdict counts what is still missing, so ticking a figure while a
    // code is on screen has to re-run it or it contradicts the grid behind it.
    renderCodeResult($('code-input').value);
    if (have && found === total && total > 0) {
      cheer(`You finished\n${state.set.name}!`);
    } else if (have) {
      burst(24);
    }
  }

  $('sheet-have').addEventListener('click', () => {
    setHave(state.figure.id, !entry(state.figure.id).have);
    renderSheetState();
  });

  $('dupe-up').addEventListener('click', () => {
    const got = entry(state.figure.id);
    // A spare only means something once you have the first one.
    setEntry(state.figure.id, { have: true, dupes: got.dupes + 1 });
    renderSheetState();
    renderCollection();
  });

  $('dupe-down').addEventListener('click', () => {
    const got = entry(state.figure.id);
    setEntry(state.figure.id, { dupes: Math.max(0, got.dupes - 1) });
    renderSheetState();
    renderCollection();
  });

  $('photo-input').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || !state.figure) return;
    const blob = await shrink(file);
    await putPhoto(photoKey(state.figure.id), blob);
    await showSheetPhoto();
    renderCollection();
    document.dispatchEvent(new CustomEvent('collect:changed'));
  });

  $('photo-remove').addEventListener('click', async () => {
    await delPhoto(photoKey(state.figure.id));
    await showSheetPhoto();
    renderCollection();
    document.dispatchEvent(new CustomEvent('collect:changed'));
  });

  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (event) => {
    if (event.target === $('sheet')) closeSheet();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('sheet').hidden) closeSheet();
  });

  /* ---------------------------------------------------------------- routing */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Bumped on every route so a superseded one can abandon itself. */
  let routeTicket = 0;

  async function route() {
    closeSheet();

    /*
     * Routing is asynchronous and can be re-entered before it finishes — a
     * tap on Back then another set, or simply a slow read. Offline that gap is
     * seconds wide, and without a guard the FIRST request to finish last wins:
     * the app settles on a collection the child is no longer looking at, with
     * the right title and the wrong figures.
     *
     * Each run takes a ticket and abandons itself if another has started.
     */
    const ticket = (routeTicket += 1);
    const superseded = () => ticket !== routeTicket;

    const match = /#set=(.+)$/.exec(location.hash || '');
    if (!match) {
      state.set = null;
      state.codes = null;
      $('picker').hidden = false;
      $('collection').hidden = true;
      $('back').hidden = true;
      $('title').textContent = 'My Collection';
      $('subtitle').textContent = 'Pick a set to start';
      renderPicker();
      return;
    }

    const id = decodeURIComponent(match[1]);
    const meta = state.index.find((s) => s.id === id);
    if (!meta) { location.hash = ''; return; }

    let set;
    try {
      const resp = await fetch(`/collect/sets/${encodeURIComponent(meta.file)}`);
      set = await resp.json();
    } catch {
      if (superseded()) return;
      $('subtitle').textContent = 'That set could not be loaded.';
      return;
    }
    if (superseded()) return;

    /*
     * The codes are a separate fetch, and a failure is deliberately not fatal.
     * They are a bonus on top of the checklist; if they cannot be had, the
     * finder hides itself and everything else still works offline.
     */
    let codes = null;
    if (set.codeFile) {
      try {
        const resp = await fetch(`/collect/sets/${encodeURIComponent(set.codeFile)}`);
        if (resp.ok) codes = await resp.json();
      } catch { /* the checklist is the point; the lookup is extra */ }
    }
    if (superseded()) return;

    // Nothing is published to the screen until every read is done and this run
    // is still the current one, so a losing race cannot half-apply.
    state.set = set;
    state.codes = codes;
    state.progress = loadProgress(set.id);
    $('picker').hidden = true;
    $('collection').hidden = false;
    $('back').hidden = false;
    renderCollection();
    renderFinder();
  }

  $('back').addEventListener('click', () => { location.hash = ''; });
  window.addEventListener('hashchange', route);
  window.addEventListener('resize', sizeCanvas);

  /* ------------------------------------------------------------------- init */

  (async function init() {
    sizeCanvas();
    try {
      const resp = await fetch('/collect/sets/index.json');
      state.index = await resp.json();
    } catch {
      state.index = [];
    }
    await route();
  }());

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/collect/sw.js').catch(() => { /* offline is a bonus */ });
    });
  }

  // Exposed for the tests, which drive the real page rather than a mock, and
  // for sync.js, which needs to read and write photos without owning the store.
  window.__collect = {
    state,
    setHave,
    openSheet,
    closeSheet,
    route,
    countFound: () => (state.set ? state.set.figures.filter((f) => entry(f.id).have).length : 0),
    photos: {
      get: getPhoto,
      put: putPhoto,
      delete: delPhoto,
      keys: async () => (await photoKeys()) || [],
    },
    catalogue: {
      get: getCatalogue,
      put: putCatalogue,
      delete: delCatalogue,
      keys: async () => (await catalogueKeys()) || [],
    },
  };

  /*
   * Another device's work has arrived. Re-read what was saved underneath us
   * and redraw.
   *
   * The open figure card is deliberately left open. He may be standing in a
   * shop looking at it, and having it vanish because a parent ticked something
   * at home would be worse than the card being a moment out of date — it is
   * refreshed in place instead.
   */
  document.addEventListener('collect:synced', async () => {
    if (!state.set) { renderPicker(); return; }
    state.progress = loadProgress(state.set.id);
    renderCollection();
    renderCodeResult($('code-input').value);
    if (!$('sheet').hidden && state.figure) {
      renderSheetState();
      renderCodes();
      await showSheetPhoto();
    }
  });
}());
