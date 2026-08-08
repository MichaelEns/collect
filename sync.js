/*
 * Keeping one collection on more than one device.
 *
 * The app was built to work with no network at all, and that does not change:
 * everything here is an extra layer on top of local storage, and every part of
 * it is allowed to fail. If sync never succeeds, the app behaves exactly as it
 * did before — which is why nothing below is ever awaited on a path a child is
 * waiting for.
 *
 * There is no account and no password. One four-word "family code" identifies a
 * collection, and holding it is what grants access. A six-year-old cannot
 * manage a login; he can read four words off a sticky note, once, on a second
 * device.
 *
 * The merge deliberately lives on the server, not here. This file pushes
 * everything it has and adopts whatever comes back. That means two devices can
 * never disagree about what merging means, which is the usual way sync starts
 * eating people's data.
 *
 * Talking to the app
 * ------------------
 * Through events, so neither file has to load first:
 *   collect:changed   the app says something was edited   -> we schedule a push
 *   collect:synced    we say remote data was adopted      -> the app re-renders
 *   collect:sync-state we say the status changed          -> the app redraws it
 */
'use strict';

(function () {
  const ENDPOINT = 'https://collect-sync.michaelens.workers.dev';

  const CODE_KEY = 'collect.familyCode';
  const HASH_KEY = 'collect.photoHashes';
  const PROGRESS_KEY = (setId) => `collect.progress.${setId}`;

  /*
   * Workers KV allows 1,000 writes a day. A tick is one edit and an
   * enthusiastic afternoon is hundreds of them, so pushes are batched: wait
   * for a lull, and never push more often than the floor below.
   */
  const QUIET_MS = 2500;
  const MIN_GAP_MS = 8000;

  const state = {
    status: 'off',
    detail: '',
    lastSyncAt: 0,
    inFlight: false,
    pending: false,
    timer: null,
    lastPushAt: 0,
  };

  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* full */ } },
    remove(key) { try { window.localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  const getCode = () => store.get(CODE_KEY) || '';

  function setStatus(status, detail = '') {
    state.status = status;
    state.detail = detail;
    document.dispatchEvent(new CustomEvent('collect:sync-state', {
      detail: { status, message: detail, lastSyncAt: state.lastSyncAt },
    }));
  }

  /* ------------------------------------------------------------- the wire */

  async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const code = getCode();
    const response = await fetch(ENDPOINT + path, {
      method,
      headers: { ...(code ? { 'X-Family-Code': code } : {}), ...headers },
      body,
    });
    if (!response.ok) {
      const error = new Error(`sync ${method} ${path} -> ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return raw ? response : response.json();
  }

  /* ----------------------------------------------------------- local reads */

  /** Every set's progress, in the shape the server merges. */
  function localProgress() {
    const out = {};
    for (const meta of (window.__collect && window.__collect.state.index) || []) {
      let saved = {};
      try { saved = JSON.parse(store.get(PROGRESS_KEY(meta.id)) || '{}') || {}; } catch { saved = {}; }
      // Skip sets he has never touched, so a push stays small.
      if (Object.keys(saved).length) out[meta.id] = saved;
    }
    return out;
  }

  function adoptProgress(progress) {
    let changed = false;
    for (const [setId, entries] of Object.entries(progress || {})) {
      const next = JSON.stringify(entries);
      if (next !== (store.get(PROGRESS_KEY(setId)) || '{}')) {
        store.set(PROGRESS_KEY(setId), next);
        changed = true;
      }
    }
    return changed;
  }

  /* ---------------------------------------------------------------- photos */

  const hashes = {
    all() { try { return JSON.parse(store.get(HASH_KEY) || '{}') || {}; } catch { return {}; } },
    set(key, hash) { const a = hashes.all(); a[key] = hash; store.set(HASH_KEY, JSON.stringify(a)); },
    drop(key) { const a = hashes.all(); delete a[key]; store.set(HASH_KEY, JSON.stringify(a)); },
  };

  /** First 32 bits of a SHA-256, which is plenty to notice a photo changed. */
  async function hashBlob(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest).slice(0, 8)]
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const photos = () => (window.__collect && window.__collect.photos) || null;

  /**
   * Reconciles photos in both directions.
   *
   * Runs after progress, and never blocks it: a photo is nice to have on the
   * other device, whereas knowing whether he already owns Boba Fett is the
   * thing he is standing in a shop trying to find out.
   */
  async function syncPhotos(remote) {
    const api = photos();
    if (!api) return false;
    const localKeys = await api.keys();
    const known = hashes.all();
    let pulled = false;

    for (const key of localKeys) {
      // IndexedDB keys are "setId/figureId"; the wire uses "setId:figureId".
      const [setId, figureId] = key.split('/');
      if (!setId || !figureId) continue;
      const wire = `${setId}:${figureId}`;
      const blob = await api.get(key);
      if (!blob) continue;

      let hash = known[key];
      if (!hash) { hash = await hashBlob(blob); hashes.set(key, hash); }
      if (remote[wire] === hash) continue;

      try {
        await call(`/v1/photo/${encodeURIComponent(setId)}/${encodeURIComponent(figureId)}`, {
          method: 'PUT', body: blob, headers: { 'X-Photo-Hash': hash },
        });
        remote[wire] = hash;
      } catch { /* try again next time */ }
    }

    for (const [wire, hash] of Object.entries(remote)) {
      const [setId, figureId] = wire.split(':');
      if (!setId || !figureId) continue;
      const key = `${setId}/${figureId}`;
      if (localKeys.includes(key) && hashes.all()[key] === hash) continue;
      if (localKeys.includes(key)) continue;
      try {
        const response = await call(
          `/v1/photo/${encodeURIComponent(setId)}/${encodeURIComponent(figureId)}`, { raw: true }
        );
        const blob = await response.blob();
        await api.put(key, blob);
        hashes.set(key, hash);
        pulled = true;
      } catch { /* try again next time */ }
    }
    return pulled;
  }

  /* ------------------------------------------------------------ the cycle */

  async function run() {
    if (!getCode()) { setStatus('off'); return; }
    if (state.inFlight) { state.pending = true; return; }
    state.inFlight = true;
    setStatus('syncing');

    try {
      const result = await call('/v1/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: localProgress() }),
      });

      const changed = adoptProgress(result.progress);
      state.lastSyncAt = Date.now();
      state.lastPushAt = Date.now();
      if (changed) document.dispatchEvent(new CustomEvent('collect:synced'));
      setStatus('ok');

      const pulled = await syncPhotos(result.photos || {});
      if (pulled) document.dispatchEvent(new CustomEvent('collect:synced'));
    } catch (err) {
      /*
       * A wrong code is worth interrupting for; anything else is not. Being
       * offline is the normal state of this app, and a red banner every time
       * he opens it in a shop would train him to ignore the one that matters.
       */
      if (err.status === 401) setStatus('bad-code', 'That code was not recognised.');
      else if (err.status === 429) setStatus('offline', 'Too many tries just now.');
      else setStatus(navigator.onLine ? 'error' : 'offline', 'Not synced yet.');
    } finally {
      state.inFlight = false;
      if (state.pending) { state.pending = false; schedule(); }
    }
  }

  /** Waits for a lull, then pushes — but never faster than MIN_GAP_MS. */
  function schedule() {
    if (!getCode()) return;
    if (state.timer) clearTimeout(state.timer);
    const since = Date.now() - state.lastPushAt;
    const wait = Math.max(QUIET_MS, MIN_GAP_MS - since);
    state.timer = setTimeout(() => { state.timer = null; run(); }, wait);
  }

  /* -------------------------------------------------------------- the API */

  const api = {
    endpoint: ENDPOINT,
    getCode,
    status: () => ({ ...state }),

    async create() {
      const { code } = await call('/v1/new', { method: 'POST' });
      store.set(CODE_KEY, code);
      await run();
      return code;
    },

    /**
     * Joins an existing collection. Pulls before pushing, so this device's
     * data and the other device's data both survive the first contact.
     */
    async join(raw) {
      const code = String(raw || '').toLowerCase().trim().split(/[^a-z]+/).filter(Boolean).join('-');
      if (code.split('-').length !== 4) {
        setStatus('bad-code', 'A family code is four words.');
        return false;
      }
      const previous = getCode();
      store.set(CODE_KEY, code);
      try {
        await call('/v1/collection');
      } catch (err) {
        if (previous) store.set(CODE_KEY, previous); else store.remove(CODE_KEY);
        setStatus(err.status === 401 ? 'bad-code' : 'error',
          err.status === 401 ? 'That code was not recognised.' : 'Could not reach sync.');
        return false;
      }
      await run();
      return true;
    },

    stop() {
      store.remove(CODE_KEY);
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      setStatus('off');
    },

    syncNow: run,
    schedule,
  };

  window.CollectSync = api;

  document.addEventListener('collect:changed', schedule);

  /*
   * When a device syncs
   * -------------------
   *   - shortly after the app opens
   *   - after an edit, once things go quiet
   *   - when the app is brought back to the front
   *   - when the network comes back
   *
   * There is deliberately NO periodic poll. A device sitting untouched with
   * the app open will show stale data until something wakes it.
   *
   * That is safe because of the merge rather than the timing: being stale
   * costs a stale SCREEN, never data. When the device does sync, the union
   * rule means nothing it holds is dropped, and per-figure newest-wins means
   * nothing it did is overwritten. It catches up rather than losing.
   *
   * Coming back to the app is also the only moment the staleness could
   * matter, since it is the moment somebody looks at the screen — and phones
   * fire visibilitychange on app switch, tab change and screen lock, so in
   * practice it fires constantly.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getCode()) run();
  });
  window.addEventListener('online', () => { if (getCode()) run(); });

  if (getCode()) setTimeout(run, 1200);
}());
