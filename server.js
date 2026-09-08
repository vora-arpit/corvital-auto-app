import crypto from 'node:crypto';
import express from 'express';
import { config } from './src/config.js';
import { syncProduct } from './src/sync-product.js';

const app = express();
const seenWebhookIds = new Map();

function validWebhookHmac(rawBody, receivedHmac) {
  if (!receivedHmac) return false;
  const digest = crypto
    .createHmac('sha256', config.clientSecret)
    .update(rawBody)
    .digest('base64');

  const a = Buffer.from(digest, 'utf8');
  const b = Buffer.from(String(receivedHmac), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rememberWebhook(id) {
  if (!id) return false;
  const now = Date.now();
  for (const [key, ts] of seenWebhookIds) {
    if (now - ts > 10 * 60 * 1000) seenWebhookIds.delete(key);
  }
  if (seenWebhookIds.has(id)) return true;
  seenWebhookIds.set(id, now);
  return false;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'corvital-metafield-automation' });
});

// IMPORTANT: raw body is required for Shopify HMAC verification.
app.post('/webhooks/products', express.raw({ type: 'application/json', limit: '2mb' }), (req, res) => {
  const rawBody = req.body;
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic') || 'unknown';
  const webhookId = req.get('X-Shopify-Webhook-Id') || '';

  if (!validWebhookHmac(rawBody, hmac)) {
    console.warn(`[webhook] Invalid HMAC for topic=${topic}`);
    return res.status(401).send('Invalid HMAC');
  }

  if (rememberWebhook(webhookId)) {
    console.log(`[webhook] Duplicate ignored id=${webhookId}`);
    return res.status(200).send('Duplicate');
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  const gid = payload.admin_graphql_api_id || (payload.id ? `gid://shopify/Product/${payload.id}` : null);
  if (!gid) return res.status(200).send('No product id');

  // Acknowledge immediately; process on the persistent Node service after response.
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      console.log(`[webhook] ${topic} -> ${gid}`);
      await syncProduct(gid);
    } catch (error) {
      console.error(`[webhook] Failed ${topic} ${gid}:`, error);
    }
  });
});

app.listen(config.port, () => {
  console.log(`CorVital metafield automation listening on port ${config.port}`);
  console.log(`Health: http://localhost:${config.port}/health`);
  console.log(`Webhook path: /webhooks/products`);
});
