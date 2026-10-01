/*
 * More than one real-world collection on one device.
 *
 * The original app had one unnamed collection and stored it under keys such as
 * collect.progress.<setId>. That layout remains the "primary" collection so an
 * upgrade never moves or rewrites a child's existing progress or photos.
 * Additional collections get a local id and a namespace of their own.
 */
'use strict';

(function () {
  const MANIFEST_KEY = 'collect.collections.v2';
  const ACTIVE_KEY = 'collect.activeCollection';
  const LEGACY_CODE_KEY = 'collect.familyCode';
  const PRIMARY_ID = 'primary';

  const store = {
    get(key) { try { return window.localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { window.localStorage.setItem(key, value); } catch { /* full */ } },
    remove(key) { try { window.localStorage.removeItem(key); } catch { /* ignore */ } },
  };

  function cleanName(value, fallback = 'My Collection') {
    const name = String(value || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return name || fallback;
  }

  function readManifest() {
    let saved = [];
    try {
      const parsed = JSON.parse(store.get(MANIFEST_KEY) || '[]');
      if (Array.isArray(parsed)) saved = parsed;
    } catch { /* start with the primary collection */ }

    const legacyCode = store.get(LEGACY_CODE_KEY) || '';
    const primary = saved.find((item) => item && item.id === PRIMARY_ID);
    const normalised = saved
      .filter((item) => item && typeof item.id === 'string')
      .map((item) => ({
        id: item.id,
        name: cleanName(item.name),
        code: String(item.code || ''),
        role: ['owner', 'contributor', 'viewer'].includes(item.role)
          ? item.role
          : 'owner',
      }));

    if (!primary) {
      normalised.unshift({
        id: PRIMARY_ID,
        name: 'My Collection',
        code: legacyCode,
        role: 'owner',
      });
    } else if (legacyCode) {
      const entry = normalised.find((item) => item.id === PRIMARY_ID);
      if (entry && !entry.code) entry.code = legacyCode;
    }
    return normalised;
  }

  let manifest = readManifest();

  function saveManifest() {
    store.set(MANIFEST_KEY, JSON.stringify(manifest));
    const primary = manifest.find((item) => item.id === PRIMARY_ID);
    if (primary && primary.code) store.set(LEGACY_CODE_KEY, primary.code);
    else store.remove(LEGACY_CODE_KEY);
    document.dispatchEvent(new CustomEvent('collect:collections-updated'));
  }

  function activeId() {
    const wanted = store.get(ACTIVE_KEY);
    return manifest.some((item) => item.id === wanted)
      ? wanted
      : PRIMARY_ID;
  }

  function active() {
    return manifest.find((item) => item.id === activeId()) || manifest[0];
  }

  function namespace(id = activeId()) {
    return id === PRIMARY_ID ? '' : `collect.collection.${id}.`;
  }

  function storageKey(kind, suffix = '', id = activeId()) {
    if (id === PRIMARY_ID) {
      if (kind === 'progress') return `collect.progress.${suffix}`;
      if (kind === 'history') return `collect.history.${suffix}`;
      if (kind === 'wishlist') return 'collect.wishlist';
      if (kind === 'photoHashes') return 'collect.photoHashes';
      if (kind === 'catalogueHashes') return 'collect.catalogueHashes';
    }
    return `${namespace(id)}${kind}${suffix ? `.${suffix}` : ''}`;
  }

  function mediaKey(setId, figureId, id = activeId()) {
    const key = `${setId}/${figureId}`;
    return id === PRIMARY_ID ? key : `${id}/${key}`;
  }

  function mediaPrefix(id = activeId()) {
    return id === PRIMARY_ID ? '' : `${id}/`;
  }

  function idForNewCollection() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function select(id) {
    if (!manifest.some((item) => item.id === id) || id === activeId()) return false;
    store.set(ACTIVE_KEY, id);
    document.dispatchEvent(new CustomEvent('collect:collection-changed', {
      detail: { collection: active() },
    }));
    return true;
  }

  function update(id, changes) {
    const item = manifest.find((entry) => entry.id === id);
    if (!item) return null;
    if (changes.name !== undefined) item.name = cleanName(changes.name, item.name);
    if (changes.code !== undefined) item.code = String(changes.code || '');
    if (['owner', 'contributor', 'viewer'].includes(changes.role)) {
      item.role = changes.role;
    }
    saveManifest();
    return { ...item };
  }

  function add({ name, code = '', role = 'owner' }) {
    const existing = code && manifest.find((item) => item.code === code);
    if (existing) {
      select(existing.id);
      return { ...existing };
    }
    const item = {
      id: idForNewCollection(),
      name: cleanName(name, 'Another Collection'),
      code: String(code || ''),
      role: ['owner', 'contributor', 'viewer'].includes(role) ? role : 'owner',
    };
    manifest.push(item);
    saveManifest();
    select(item.id);
    return { ...item };
  }

  function remove(id) {
    if (id === PRIMARY_ID) return false;
    const before = manifest.length;
    manifest = manifest.filter((item) => item.id !== id);
    if (manifest.length === before) return false;
    if (activeId() === id) store.set(ACTIVE_KEY, PRIMARY_ID);
    saveManifest();
    document.dispatchEvent(new CustomEvent('collect:collection-changed', {
      detail: { collection: active() },
    }));
    return true;
  }

  saveManifest();

  window.CollectCollections = {
    all: () => manifest.map((item) => ({ ...item })),
    active: () => ({ ...active() }),
    activeId,
    select,
    add,
    remove,
    update,
    updateActive: (changes) => update(activeId(), changes),
    canEdit: () => active().role !== 'viewer',
    isOwner: () => active().role === 'owner',
    storageKey,
    mediaKey,
    mediaPrefix,
  };
}());
