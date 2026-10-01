const encoder = new TextEncoder();
const decoder = new TextDecoder();
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value) {
  const padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(String(value || '').length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function encryptionKey(secret) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function createImageToken(
  secret,
  collectionCode,
  now = Date.now(),
) {
  if (!secret || !collectionCode) return '';
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({
    collectionCode,
    expiresAt: now + TOKEN_LIFETIME_MS,
  }));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await encryptionKey(secret),
    plaintext,
  ));
  const token = new Uint8Array(iv.length + ciphertext.length);
  token.set(iv);
  token.set(ciphertext, iv.length);
  return base64Url(token);
}

export async function readImageToken(secret, token, now = Date.now()) {
  if (!secret || !token) return null;
  try {
    const bytes = fromBase64Url(token);
    if (bytes.length <= 28) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      await encryptionKey(secret),
      bytes.slice(12),
    );
    const parsed = JSON.parse(decoder.decode(plaintext));
    if (!parsed || typeof parsed.collectionCode !== 'string' ||
        !Number.isFinite(parsed.expiresAt) || parsed.expiresAt < now) {
      return null;
    }
    return parsed.collectionCode;
  } catch {
    return null;
  }
}
