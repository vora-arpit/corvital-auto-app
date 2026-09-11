import crypto from 'node:crypto';
import express from 'express';

import { config } from './src/config.js';
import {
  syncProduct,
  generateProductCapsuleDraft,
} from './src/sync-product.js';

const app = express();
const APP_VERSION = 'stage3-gemini-2026-09-11-v2';
const seenWebhookIds = new Map();

function verifyWithSecret(rawBody, receivedHmac, secret) {
  if (!receivedHmac || !secret || !Buffer.isBuffer(rawBody)) return false;

  try {
    const calculated = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    const a = Buffer.from(calculated, 'base64');
    const b = Buffer.from(String(receivedHmac).trim(), 'base64');

    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (error) {
    console.error('[webhook] HMAC verification error:', error);
    return false;
  }
}

function validWebhookHmac(rawBody, receivedHmac) {
  if (verifyWithSecret(rawBody, receivedHmac, config.clientSecret)) return true;

  const oldSecret = process.env.SHOPIFY_OLD_CLIENT_SECRET;
  if (oldSecret && verifyWithSecret(rawBody, receivedHmac, oldSecret)) {
    console.log('[webhook] HMAC validated using OLD client secret.');
    return true;
  }

  return false;
}

function rememberWebhook(id) {
  if (!id) return false;

  const now = Date.now();
  const ttl = 10 * 60 * 1000;

  for (const [key, timestamp] of seenWebhookIds) {
    if (now - timestamp > ttl) seenWebhookIds.delete(key);
  }

  if (seenWebhookIds.has(id)) return true;
  seenWebhookIds.set(id, now);
  return false;
}

function secureStringEqual(a, b) {
  if (!a || !b) return false;
  const aa = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

/* ------------------------------------------------------------
   Public diagnostics
------------------------------------------------------------ */
app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'CorVital Plus Metafield Automation',
    status: 'running',
    version: APP_VERSION,
    health: '/health',
    webhook: '/webhooks/products',
    capsuleGenerator: '/admin/generate-capsule/:productId',
    routes: '/routes',
  });
});

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'corvital-metafield-automation',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
  });
});

app.get('/routes', (_req, res) => {
  res.status(200).json({
    version: APP_VERSION,
    routes: [
      'GET /',
      'GET /health',
      'GET /routes',
      'POST /webhooks/products',
      'POST /admin/generate-capsule/:productId',
    ],
  });
});

/* ------------------------------------------------------------
   Shopify webhook MUST stay before express.json()
------------------------------------------------------------ */
app.post(
  '/webhooks/products',
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req, res) => {
    const rawBody = req.body;
    const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
    const topic = req.get('X-Shopify-Topic') || 'unknown';
    const webhookId = req.get('X-Shopify-Webhook-Id') || '';
    const shopDomain = req.get('X-Shopify-Shop-Domain') || '';

    console.log(
      `[webhook] Received topic=${topic} shop=${shopDomain || 'unknown'} id=${webhookId || 'none'}`
    );

    if (!Buffer.isBuffer(rawBody)) {
      return res.status(400).send('Raw body required');
    }

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
    } catch (error) {
      console.error('[webhook] Invalid JSON payload:', error);
      return res.status(400).send('Invalid JSON');
    }

    const gid =
      payload.admin_graphql_api_id ||
      (payload.id ? `gid://shopify/Product/${payload.id}` : null);

    if (!gid) return res.status(200).send('No product id');

    try {
      console.log(`[webhook] Processing ${topic} -> ${gid}`);
      const result = await syncProduct(gid);
      console.log(`[webhook] Completed ${topic} -> ${gid}`);
      if (result) console.log('[webhook] Sync result:', result);
      return res.status(200).send('OK');
    } catch (error) {
      console.error(`[webhook] Failed ${topic} ${gid}:`, error);
      return res.status(500).send('Product sync failed');
    }
  }
);

/* Normal JSON routes start here. */
app.use(express.json({ limit: '2mb' }));

/* ------------------------------------------------------------
   Protected manual Gemini generation endpoint
------------------------------------------------------------ */
app.post('/admin/generate-capsule/:productId', async (req, res) => {
  const suppliedSecret = req.get('X-Capsule-Generator-Secret');
  const expectedSecret = process.env.CAPSULE_GENERATOR_SECRET;

  if (!secureStringEqual(suppliedSecret, expectedSecret)) {
    console.warn('[capsule-ai] Unauthorized generation request.');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const numericProductId = String(req.params.productId || '').trim();
  if (!/^\d+$/.test(numericProductId)) {
    return res.status(400).json({ error: 'Invalid Shopify product ID' });
  }

  const productGid = `gid://shopify/Product/${numericProductId}`;

  try {
    console.log(`[capsule-ai] Manual generation requested for ${productGid}`);
    const result = await generateProductCapsuleDraft(productGid);
    console.log(`[capsule-ai] Manual generation completed for ${productGid}`);
    return res.status(200).json(result);
  } catch (error) {
    console.error(`[capsule-ai] Generation failed for ${productGid}:`, error);
    return res.status(500).json({
      error: error?.message || 'Capsule generation failed',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', method: req.method, path: req.path });
});

app.listen(config.port, () => {
  console.log(`CorVital metafield automation ${APP_VERSION} listening on port ${config.port}`);
  console.log(`Health: http://localhost:${config.port}/health`);
  console.log('Webhook path: /webhooks/products');
  console.log('Capsule generator path: /admin/generate-capsule/:productId');
});
