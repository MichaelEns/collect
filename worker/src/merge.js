/*
 * Merging one device's progress into another's.
 *
 * This runs ONLY on the server. Clients push everything they have, the server
 * merges it with what it holds, and the client replaces its local copy with
 * the result. Keeping the merge in exactly one place means two devices can
 * never disagree about what merging means, which is the usual way sync eats
 * people's data.
 *
 * Two properties matter more than anything else here, because the data is a
 * six-year-old's collection and he will not notice a silent loss until he is
 * standing in a shop:
 *
 *   1. A figure known to one side is never dropped. Absence is not a delete
 *      instruction. A freshly installed device pushing {} cannot wipe anything.
 *
 *   2. The newest edit to a given figure wins, per figure, not per document.
 *      Whole-document last-write-wins would throw away everything the other
 *      device did since the last sync.
 *
 * Un-ticking still works: it writes have:false with a new timestamp, which is
 * an edit like any other.
 */

/** How far ahead of the server a device's clock may be before we distrust it. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/** Bounds, so one device cannot fill the store or blow the value size limit. */
export const LIMITS = {
  sets: 100,
  figures: 2000,
  idLength: 128,
  codesPerFigure: 200,
  codeLength: 16,
  dupes: 9999,
};

/**
 * Cleans one figure's entry.
 *
 * Anything unrecognised is dropped rather than stored. The store is writable
 * by anyone holding the family code, so this is the only thing standing
 * between a typo — or a prank — and a corrupted collection.
 */
export function sanitiseEntry(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const codes = [];
  if (Array.isArray(raw.codes)) {
    for (const code of raw.codes.slice(0, LIMITS.codesPerFigure)) {
      if (typeof code !== 'string') continue;
      const tidy = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, LIMITS.codeLength);
      if (tidy && !codes.includes(tidy)) codes.push(tidy);
    }
  }

  let dupes = Number(raw.dupes);
  if (!Number.isFinite(dupes) || dupes < 0) dupes = 0;
  dupes = Math.min(Math.floor(dupes), LIMITS.dupes);

  /*
   * A clock running fast would otherwise win every future merge, permanently,
   * because its timestamps beat everything real. Clamping to server time stops
   * one badly set tablet freezing the whole family's collection.
   */
  let updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt < 0) updatedAt = 0;
  updatedAt = Math.min(updatedAt, now + CLOCK_TOLERANCE_MS);

  return { have: raw.have === true, dupes, codes, updatedAt };
}

/** Cleans a whole progress document: { figureId: entry }. */
export function sanitiseProgress(raw, now) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let seen = 0;
  for (const [id, value] of Object.entries(raw)) {
    if (seen >= LIMITS.figures) break;
    if (typeof id !== 'string' || !id || id.length > LIMITS.idLength) continue;
    const entry = sanitiseEntry(value, now);
    if (!entry) continue;
    out[id] = entry;
    seen += 1;
  }
  return out;
}

/**
 * Merges two entries for the same figure. Newest wins; a tie keeps the one
 * already stored, so a repeated push is a no-op rather than a coin toss.
 */
export function mergeEntry(stored, incoming) {
  if (!stored) return incoming;
  if (!incoming) return stored;
  return (incoming.updatedAt > stored.updatedAt) ? incoming : stored;
}

/**
 * Merges a pushed document into the stored one.
 *
 * The key set is the UNION of both sides. This is the property that makes the
 * whole thing safe: a device that has never seen a set, or has just been
 * reinstalled, contributes nothing rather than erasing everything.
 */
export function mergeProgress(stored, incoming) {
  const out = {};
  for (const id of new Set([...Object.keys(stored || {}), ...Object.keys(incoming || {})])) {
    out[id] = mergeEntry((stored || {})[id], (incoming || {})[id]);
  }
  return out;
}

/** Merges every set in a push. Shape: { setId: { figureId: entry } }. */
export function mergeAll(stored, incoming, now) {
  const clean = {};
  if (incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
    let seen = 0;
    for (const [setId, progress] of Object.entries(incoming)) {
      if (seen >= LIMITS.sets) break;
      if (typeof setId !== 'string' || !setId || setId.length > LIMITS.idLength) continue;
      clean[setId] = sanitiseProgress(progress, now);
      seen += 1;
    }
  }
  const out = {};
  for (const setId of new Set([...Object.keys(stored || {}), ...Object.keys(clean)])) {
    out[setId] = mergeProgress((stored || {})[setId], clean[setId]);
  }
  return out;
}
