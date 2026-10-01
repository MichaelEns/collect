/*
 * Keeping one or more collections on more than one device.
 *
 * The primary collection keeps every original storage key. Additional
 * collections are namespaced by collections.js. Sync always captures the
 * active collection before crossing the network, so changing collections
 * while a request is in flight cannot write Joe's response into Grandma's
 * local collection.
 */
'use strict';

(function () {
  const ENDPOINT = 'https://collect-sync.michaelens.workers.dev';
  const collections = window.CollectCollections;
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
  };

  const getCode = () => collections.active().code || '';

  function setStatus(status, detail = '', collectionId = collections.activeId()) {
    if (collectionId !== collections.activeId()) return;
    state.status = status;
    state.detail = detail;
    document.dispatchEvent(new CustomEvent('collect:sync-state', {
      detail: { status, message: detail, lastSyncAt: state.lastSyncAt },
    }));
  }

  async function call(path, {
    method = 'GET',
    body,
    headers = {},
    raw = false,
    code = getCode(),
  } = {}) {
    const response = await fetch(ENDPOINT + path, {
      method,
      headers: { ...(code ? { 'X-Family-Code': code } : {}), ...headers },
      body,
    });
    if (!response.ok) {
      const error = new Error(`sync ${method} ${path} -> ${response.status}`);
      error.status = response.status;
      try { error.payload = await response.json(); } catch { /* not json */ }
      throw error;
    }
    return raw ? response : response.json();
  }

  function progressKey(collectionId, setId) {
    return collections.storageKey('progress', setId, collectionId);
  }

  function localProgress(collectionId) {
    const out = {};
    for (const meta of (window.__collect && window.__collect.state.index) || []) {
      let saved = {};
      try {
        saved = JSON.parse(store.get(progressKey(collectionId, meta.id)) || '{}') || {};
      } catch { saved = {}; }
      if (Object.keys(saved).length) out[meta.id] = saved;
    }
    return out;
  }

  function adoptProgress(progress, collectionId) {
    let changed = false;
    for (const [setId, entries] of Object.entries(progress || {})) {
      const next = JSON.stringify(entries);
      const key = progressKey(collectionId, setId);
      if (next !== (store.get(key) || '{}')) {
        store.set(key, next);
        changed = true;
      }
    }
    return changed;
  }

  function ledger(kind, collectionId) {
    const key = collections.storageKey(kind, '', collectionId);
    const all = () => {
      try { return JSON.parse(store.get(key) || '{}') || {}; } catch { return {}; }
    };
    return {
      all,
      set(item, hash) {
        const values = all();
        values[item] = hash;
        store.set(key, JSON.stringify(values));
      },
      drop(item) {
        const values = all();
        delete values[item];
        store.set(key, JSON.stringify(values));
      },
    };
  }

  async function hashBlob(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest).slice(0, 8)]
      .map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const photos = () => (window.__collect && window.__collect.photos) || null;
  const catalogue = () => (window.__collect && window.__collect.catalogue) || null;

  function mediaParts(key, collectionId) {
    const prefix = collections.mediaPrefix(collectionId);
    if (prefix) {
      if (!String(key).startsWith(prefix)) return null;
      const parts = String(key).slice(prefix.length).split('/');
      return parts.length === 2 ? parts : null;
    }
    const parts = String(key).split('/');
    return parts.length === 2 ? parts : null;
  }

  function collectionMediaKeys(keys, collectionId) {
    return keys.filter((key) => mediaParts(key, collectionId));
  }

  async function syncPhotos(remote, collectionId, code, canUpload) {
    const api = photos();
    if (!api) return false;
    const allKeys = await api.keys();
    const localKeys = collectionMediaKeys(allKeys, collectionId);
    const hashes = ledger('photoHashes', collectionId);
    const known = hashes.all();
    let pulled = false;

    if (canUpload) {
      for (const key of localKeys) {
        const [setId, figureId] = mediaParts(key, collectionId);
        const wire = `${setId}:${figureId}`;
        const blob = await api.get(key);
        if (!blob) continue;

        let hash = known[key];
        if (!hash) {
          hash = await hashBlob(blob);
          hashes.set(key, hash);
        }
        if (remote[wire] === hash) continue;

        try {
          await call(`/v1/photo/${encodeURIComponent(setId)}/${encodeURIComponent(figureId)}`, {
            method: 'PUT',
            body: blob,
            headers: { 'X-Photo-Hash': hash },
            code,
          });
          remote[wire] = hash;
        } catch { /* try again next time */ }
      }
    }

    for (const [wire, hash] of Object.entries(remote)) {
      const [setId, figureId] = wire.split(':');
      if (!setId || !figureId) continue;
      const key = collections.mediaKey(setId, figureId, collectionId);
      if (localKeys.includes(key) && hashes.all()[key] === hash) continue;
      if (localKeys.includes(key)) continue;
      try {
        const response = await call(
          `/v1/photo/${encodeURIComponent(setId)}/${encodeURIComponent(figureId)}`,
          { raw: true, code },
        );
        await api.put(key, await response.blob());
        hashes.set(key, hash);
        pulled = true;
      } catch { /* try again next time */ }
    }
    return pulled;
  }

  async function syncCatalogue(remote, collectionId, code) {
    const api = catalogue();
    if (!api) return false;
    const allKeys = await api.keys();
    const localKeys = collectionMediaKeys(allKeys, collectionId);
    const hashes = ledger('catalogueHashes', collectionId);
    const known = hashes.all();
    let changed = false;

    for (const [wire, hash] of Object.entries(remote)) {
      const [setId, figureId] = wire.split(':');
      if (!setId || !figureId) continue;
      const key = collections.mediaKey(setId, figureId, collectionId);
      if (localKeys.includes(key) && known[key] === hash) continue;
      try {
        const response = await call(
          `/v1/catalogue/${encodeURIComponent(setId)}/${encodeURIComponent(figureId)}`,
          { raw: true, code },
        );
        await api.put(key, await response.blob());
        hashes.set(key, hash);
        changed = true;
      } catch { /* try again next time */ }
    }

    for (const key of localKeys) {
      const [setId, figureId] = mediaParts(key, collectionId);
      if (`${setId}:${figureId}` in remote) continue;
      try {
        await api.delete(key);
        hashes.drop(key);
        changed = true;
      } catch { /* try again next time */ }
    }
    return changed;
  }

  async function run() {
    const profile = collections.active();
    const code = profile.code;
    if (!getCode()) { setStatus('off'); return; }
    if (state.inFlight) { state.pending = true; return; }
    state.inFlight = true;
    setStatus('syncing', '', profile.id);

    try {
      const canUpload = profile.role !== 'viewer';
      const result = await call('/v1/collection', canUpload ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ progress: localProgress(profile.id) }),
        code,
      } : { code });

      collections.update(profile.id, {
        name: result.name || profile.name,
        role: result.role || profile.role,
      });
      const changed = adoptProgress(result.progress, profile.id);
      state.lastSyncAt = Date.now();
      state.lastPushAt = Date.now();
      if (changed && profile.id === collections.activeId()) {
        document.dispatchEvent(new CustomEvent('collect:synced'));
      }
      setStatus('ok', '', profile.id);

      const pulled = await syncPhotos(
        result.photos || {},
        profile.id,
        code,
        canUpload,
      );
      if (pulled && profile.id === collections.activeId()) {
        document.dispatchEvent(new CustomEvent('collect:synced'));
      }

      if (result.catalogue) {
        const catalogueChanged = await syncCatalogue(
          result.catalogue,
          profile.id,
          code,
        );
        if (catalogueChanged && profile.id === collections.activeId()) {
          document.dispatchEvent(new CustomEvent('collect:synced'));
        }
      }
    } catch (error) {
      if (error.status === 401) {
        setStatus('bad-code', 'That code was not recognised.', profile.id);
      } else if (error.status === 403) {
        setStatus('error', 'This sharing code cannot change that collection.', profile.id);
      } else if (error.status === 429) {
        setStatus('offline', 'Too many tries just now.', profile.id);
      } else {
        setStatus(
          navigator.onLine ? 'error' : 'offline',
          'Not synced yet.',
          profile.id,
        );
      }
    } finally {
      state.inFlight = false;
      if (state.pending) {
        state.pending = false;
        schedule();
      }
    }
  }

  function schedule() {
    if (!getCode()) return;
    if (state.timer) clearTimeout(state.timer);
    const since = Date.now() - state.lastPushAt;
    const wait = Math.max(QUIET_MS, MIN_GAP_MS - since);
    state.timer = setTimeout(() => {
      state.timer = null;
      run();
    }, wait);
  }

  function normaliseCode(raw) {
    const code = String(raw || '').toLowerCase().trim()
      .split(/[^a-z]+/).filter(Boolean).join('-');
    return code.split('-').length === 4 ? code : '';
  }

  async function inspectCode(raw) {
    const code = normaliseCode(raw);
    if (!code) {
      setStatus('bad-code', 'A sharing code is four words.');
      return null;
    }
    try {
      return {
        code,
        ...(await call('/v1/access', { code })),
      };
    } catch (error) {
      setStatus(
        error.status === 401 ? 'bad-code' : 'error',
        error.status === 401
          ? 'That code was not recognised.'
          : 'Could not reach sharing.',
      );
      return null;
    }
  }

  const api = {
    endpoint: ENDPOINT,
    getCode,
    status: () => ({ ...state }),
    collections: () => collections.all(),
    activeCollection: () => collections.active(),
    selectCollection: collections.select,

    async create() {
      const active = collections.active();
      const result = await call('/v1/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: active.name }),
        code: '',
      });
      collections.update(active.id, result);
      await run();
      return result.code;
    },

    async join(raw) {
      const access = await inspectCode(raw);
      if (!access) return false;
      if (access.role === 'viewer' &&
          Object.keys(localProgress(collections.activeId())).length) {
        setStatus(
          'error',
          'This collection already has local finds. Add the view-only code as another collection instead.',
        );
        return false;
      }
      collections.updateActive(access);
      await run();
      return true;
    },

    async add(raw) {
      const access = await inspectCode(raw);
      if (!access) return false;
      collections.add(access);
      await run();
      return true;
    },

    addLocal(name) {
      return collections.add({ name, role: 'owner' });
    },

    removeActive() {
      return collections.remove(collections.activeId());
    },

    async rename(name) {
      const active = collections.active();
      collections.updateActive({ name });
      if (!active.code || active.role !== 'owner') return collections.active();
      const result = await call('/v1/collection-info', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
        code: active.code,
      });
      collections.update(active.id, result);
      return collections.active();
    },

    async shares() {
      if (!collections.isOwner() || !getCode()) return [];
      return (await call('/v1/shares')).shares || [];
    },

    async createShare(role) {
      if (!collections.isOwner() || !getCode()) return null;
      return call('/v1/shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      });
    },

    async revokeShare(code) {
      if (!collections.isOwner() || !getCode()) return false;
      await call(`/v1/shares/${encodeURIComponent(code)}`, {
        method: 'DELETE',
      });
      return true;
    },

    stop() {
      collections.updateActive({ code: '', role: 'owner' });
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      setStatus('off');
    },

    syncNow: run,
    schedule,
  };

  window.CollectSync = api;

  document.addEventListener('collect:changed', schedule);
  document.addEventListener('collect:collection-changed', () => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.status = getCode() ? 'syncing' : 'off';
    state.detail = '';
    state.lastSyncAt = 0;
    document.dispatchEvent(new CustomEvent('collect:sync-state', {
      detail: { status: state.status, message: '', lastSyncAt: 0 },
    }));
    if (getCode()) run();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getCode()) run();
  });
  window.addEventListener('online', () => { if (getCode()) run(); });

  if (getCode()) setTimeout(run, 1200);
}());
