import { makeCode, normaliseCode } from './code.js';

export const progressKey = (code) => `p:${code}`;
export const collectionInfoKey = (code) => `info:${code}`;
export const shareKey = (code) => `share:${code}`;
export const shareIndexKey = (code) => `shares:${code}`;

const ROLES = new Set(['viewer', 'contributor']);
const DEFAULT_COLLECTION_NAME = 'My Collection';

function cleanName(value) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return name.slice(0, 60) || DEFAULT_COLLECTION_NAME;
}

function parseJson(raw, fallback) {
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : fallback;
  } catch {
    return fallback;
  }
}

export async function collectionInfo(env, collectionCode) {
  const stored = parseJson(
    await env.COLLECT.get(collectionInfoKey(collectionCode)),
    {},
  );
  return {
    name: cleanName(stored.name),
  };
}

export async function setCollectionName(env, collectionCode, name) {
  const info = { name: cleanName(name) };
  await env.COLLECT.put(collectionInfoKey(collectionCode), JSON.stringify(info));
  return info;
}

export async function resolveAccess(env, rawCode) {
  const credentialCode = normaliseCode(rawCode);
  if (!credentialCode) return null;

  if (await env.COLLECT.get(progressKey(credentialCode)) !== null) {
    const info = await collectionInfo(env, credentialCode);
    return {
      credentialCode,
      collectionCode: credentialCode,
      name: info.name,
      role: 'owner',
    };
  }

  const record = parseJson(
    await env.COLLECT.get(shareKey(credentialCode)),
    null,
  );
  if (!record || !ROLES.has(record.role)) return null;
  const collectionCode = normaliseCode(record.collectionCode);
  if (!collectionCode ||
      await env.COLLECT.get(progressKey(collectionCode)) === null) {
    return null;
  }
  const info = await collectionInfo(env, collectionCode);
  return {
    credentialCode,
    collectionCode,
    name: info.name,
    role: record.role,
  };
}

export async function allocateCode(env) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = makeCode();
    const [collection, share] = await Promise.all([
      env.COLLECT.get(progressKey(code)),
      env.COLLECT.get(shareKey(code)),
    ]);
    if (collection === null && share === null) return code;
  }
  return null;
}

async function shareIndex(env, collectionCode) {
  return parseJson(
    await env.COLLECT.get(shareIndexKey(collectionCode)),
    {},
  );
}

export async function listShares(env, collectionCode) {
  const index = await shareIndex(env, collectionCode);
  return Object.entries(index)
    .filter(([, entry]) => entry && ROLES.has(entry.role))
    .map(([code, entry]) => ({
      code,
      role: entry.role,
      createdAt: Number(entry.createdAt) || 0,
    }))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export async function createShare(env, collectionCode, role) {
  if (!ROLES.has(role)) return null;
  const code = await allocateCode(env);
  if (!code) return null;
  const record = {
    collectionCode,
    role,
    createdAt: Date.now(),
  };
  const index = await shareIndex(env, collectionCode);
  index[code] = {
    role: record.role,
    createdAt: record.createdAt,
  };
  await env.COLLECT.put(shareKey(code), JSON.stringify(record));
  await env.COLLECT.put(
    shareIndexKey(collectionCode),
    JSON.stringify(index),
  );
  return { code, role: record.role, createdAt: record.createdAt };
}

export async function revokeShare(env, collectionCode, rawShareCode) {
  const code = normaliseCode(rawShareCode);
  if (!code) return false;
  const record = parseJson(await env.COLLECT.get(shareKey(code)), null);
  if (!record || record.collectionCode !== collectionCode) return false;

  await env.COLLECT.delete(shareKey(code));
  const index = await shareIndex(env, collectionCode);
  if (code in index) {
    delete index[code];
    await env.COLLECT.put(
      shareIndexKey(collectionCode),
      JSON.stringify(index),
    );
  }
  return true;
}

export const canContribute = (access) =>
  access && (access.role === 'owner' || access.role === 'contributor');

export const isOwner = (access) => access && access.role === 'owner';
