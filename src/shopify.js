import { config } from './config.js';

let tokenCache = {
  accessToken: null,
  expiresAt: 0,
  scope: '',
};

export async function getAccessToken(forceRefresh = false) {
  // Refresh 5 minutes early so a token never expires mid-request.
  const safeNow = Date.now() + 5 * 60 * 1000;
  if (!forceRefresh && tokenCache.accessToken && tokenCache.expiresAt > safeNow) {
    return tokenCache.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const response = await fetch(`https://${config.shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok || !json.access_token) {
    throw new Error(`Shopify token request failed (${response.status}): ${JSON.stringify(json)}`);
  }

  const expiresIn = Number(json.expires_in || 3600);
  tokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scope: json.scope || '',
  };

  console.log(`[auth] New Shopify token. Scope=${tokenCache.scope || 'unknown'} expires_in=${expiresIn}s`);
  return tokenCache.accessToken;
}

export function invalidateAccessToken() {
  tokenCache = { accessToken: null, expiresAt: 0, scope: '' };
}

export async function shopifyGraphQL(query, variables = {}, retried = false) {
  const token = await getAccessToken(false);
  const response = await fetch(`https://${config.shop}/admin/api/${config.apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });

  // One automatic token refresh + retry if Shopify rejects the cached token.
  if (response.status === 401 && !retried) {
    console.warn('[auth] Shopify returned 401. Refreshing token and retrying once.');
    invalidateAccessToken();
    await getAccessToken(true);
    return shopifyGraphQL(query, variables, true);
  }

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Shopify GraphQL HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}
