import { createImageToken, readImageToken } from './image-token.js';

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

export async function collectionImageUrl(env, collectionCode, setId, figureId) {
  if (!env.ALEXA_IMAGE_SIGNING_KEY) return '';
  const token = await createImageToken(
    env.ALEXA_IMAGE_SIGNING_KEY,
    collectionCode,
  );
  const base = (env.PUBLIC_BASE_URL ||
    'https://collect-sync.michaelens.workers.dev').replace(/\/+$/, '');
  return `${base}/alexa/image/${encodeURIComponent(setId)}/` +
    `${encodeURIComponent(figureId)}?token=${encodeURIComponent(token)}`;
}

export async function handleAlexaImage(request, env) {
  if (request.method !== 'GET') {
    return new Response('Method not allowed.', { status: 405 });
  }
  const url = new URL(request.url);
  const match = /^\/alexa\/image\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match) return new Response('Not found.', { status: 404 });
  const setId = decodeURIComponent(match[1]);
  const figureId = decodeURIComponent(match[2]);
  if (!SAFE_ID.test(setId) || !SAFE_ID.test(figureId)) {
    return new Response('Bad image id.', { status: 400 });
  }
  const collectionCode = await readImageToken(
    env.ALEXA_IMAGE_SIGNING_KEY,
    url.searchParams.get('token'),
  );
  if (!collectionCode ||
      await env.COLLECT.get(`p:${collectionCode}`) === null) {
    return new Response('Image link expired.', { status: 401 });
  }

  const ownKey = `ph:${collectionCode}:${setId}:${figureId}`;
  const catalogueKey = `cat:${collectionCode}:${setId}:${figureId}`;
  let object = await env.COLLECT.getWithMetadata(
    ownKey,
    { type: 'arrayBuffer' },
  );
  if (!object || !object.value) {
    object = await env.COLLECT.getWithMetadata(
      catalogueKey,
      { type: 'arrayBuffer' },
    );
  }
  if (!object || !object.value) {
    return new Response('No image.', { status: 404 });
  }
  return new Response(object.value, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=300',
    },
  });
}
