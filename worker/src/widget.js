let cachedToken = null;

async function skillToken(env) {
  if (!env.ALEXA_CLIENT_ID || !env.ALEXA_CLIENT_SECRET) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.value;
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.ALEXA_CLIENT_ID,
    client_secret: env.ALEXA_CLIENT_SECRET,
    scope: 'alexa::datastore',
  });
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) {
    throw new Error(`Alexa widget token request returned ${response.status}.`);
  }
  const result = await response.json();
  if (!result.access_token) {
    throw new Error('Alexa widget token response had no access token.');
  }
  cachedToken = {
    value: result.access_token,
    expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000,
  };
  return cachedToken.value;
}

function alexaUserId(envelope) {
  return envelope.context && envelope.context.System &&
    envelope.context.System.user && envelope.context.System.user.userId ||
    envelope.session && envelope.session.user && envelope.session.user.userId;
}

export async function widgetSummary(queryService, progress) {
  const sets = await queryService.collectionSets(progress);
  const found = sets.reduce((total, set) => total + set.found, 0);
  const total = sets.reduce((sum, set) => sum + set.total, 0);
  return {
    title: "Joe's Collection",
    progress: `${found} of ${total} found`,
    found,
    total,
  };
}

export async function updateCollectionWidget(
  envelope,
  env,
  queryService,
  progress,
) {
  const token = await skillToken(env);
  const userId = alexaUserId(envelope);
  if (!token || !userId) return false;
  const endpoint = env.ALEXA_DATASTORE_ENDPOINT ||
    'https://api.amazonalexa.com';
  const summary = await widgetSummary(queryService, progress);
  const response = await fetch(`${endpoint}/v1/datastore/commands`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      commands: [{
        type: 'PUT_OBJECT',
        namespace: 'JoesCollection',
        key: 'summary',
        content: summary,
      }],
      target: {
        type: 'USER',
        id: userId,
      },
      attemptDeliveryUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error(`Alexa widget update returned ${response.status}.`);
  }
  return true;
}
