import crypto from 'node:crypto';
import express from 'express';

import { config } from './src/config.js';
import { syncProduct, listAllProducts } from './src/sync-product.js';
import { generateProductContent } from './src/product-content.js';

const app = express();
const APP_VERSION = 'stage4j-direct-manual-approval-2026-09-12';
const seenWebhookIds = new Map();

function verifyWithSecret(rawBody, receivedHmac, secret) {
  if (!receivedHmac || !secret || !Buffer.isBuffer(rawBody)) return false;
  try {
    const calculated = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
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
  if (oldSecret && verifyWithSecret(rawBody, receivedHmac, oldSecret)) return true;
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

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'CorVital Plus Metafield Automation',
    status: 'running',
    version: APP_VERSION,
    health: '/health',
    webhook: '/webhooks/products',
    contentGenerator: '/admin/generate-product-content/:productId',
    bulkContentGenerator: '/admin/generate-all-products',
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
      'POST /admin/generate-product-content/:productId',
      'POST /admin/generate-all-products',
    ],
  });
});

// Shopify webhook must stay before express.json().
app.post(
  '/webhooks/products',
  express.raw({ type: 'application/json', limit: '2mb' }),
  async (req, res) => {
    const rawBody = req.body;
    const hmac = req.get('X-Shopify-Hmac-Sha256') || '';
    const topic = req.get('X-Shopify-Topic') || 'unknown';
    const webhookId = req.get('X-Shopify-Webhook-Id') || '';

    if (!Buffer.isBuffer(rawBody)) return res.status(400).send('Raw body required');
    if (!validWebhookHmac(rawBody, hmac)) return res.status(401).send('Invalid HMAC');
    if (rememberWebhook(webhookId)) return res.status(200).send('Duplicate');

    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).send('Invalid JSON');
    }

    const gid = payload.admin_graphql_api_id ||
      (payload.id ? `gid://shopify/Product/${payload.id}` : null);

    if (!gid) return res.status(200).send('No product id');

    try {
      const result = await syncProduct(gid);
      console.log(`[webhook] ${topic} -> ${gid}`, result);
      return res.status(200).send('OK');
    } catch (error) {
      console.error(`[webhook] Failed ${topic} ${gid}:`, error);
      return res.status(500).send('Product sync failed');
    }
  }
);

app.use(express.json({ limit: '2mb' }));

app.post('/admin/generate-product-content/:productId', async (req, res) => {
  const suppliedSecret = req.get('X-Content-Generator-Secret');
  const expectedSecret = process.env.CONTENT_GENERATOR_SECRET;

  if (!secureStringEqual(suppliedSecret, expectedSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const numericProductId = String(req.params.productId || '').trim();
  if (!/^\d+$/.test(numericProductId)) {
    return res.status(400).json({ error: 'Invalid Shopify product ID' });
  }

  // Preview by default. Pass JSON body { "write": true } only when you want
  // validated content written to Shopify metafields.
  const write = req.body?.write === true;
  const productGid = `gid://shopify/Product/${numericProductId}`;

  try {
    const result = await generateProductContent(productGid, { write });
    return res.status(200).json(result);
  } catch (error) {
    console.error(`[content-ai] Generation failed for ${productGid}:`, error);
    return res.status(500).json({
      error: error?.message || 'Content generation failed',
    });
  }
});



function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.post('/admin/generate-all-products', async (req, res) => {
  const suppliedSecret = req.get('X-Content-Generator-Secret');
  const expectedSecret = process.env.CONTENT_GENERATOR_SECRET;

  if (!secureStringEqual(suppliedSecret, expectedSecret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Safe defaults:
  // - preview only unless write === true
  // - refresh source metafields before Claude unless sync_sources === false
  // - wait 1.5 seconds between products to reduce rate-limit pressure
  const write = req.body?.write === true;
  const syncSources = req.body?.sync_sources !== false;
  const requestedDelay = Number(req.body?.delay_ms ?? 1500);
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(500, Math.min(10000, Math.round(requestedDelay)))
    : 1500;

  // Optional limit is useful for a small test run, e.g. {"write":false,"limit":2}
  const requestedLimit = Number(req.body?.limit ?? 0);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
    : 0;

  try {
    let products = await listAllProducts();
    if (limit) products = products.slice(0, limit);

    const results = [];
    let successful = 0;
    let failed = 0;
    let written = 0;
    let needsReview = 0;

    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      const row = {
        index: index + 1,
        id: product.id,
        title: product.title,
        handle: product.handle,
        status: 'pending',
      };

      try {
        if (syncSources) {
          row.source_sync = await syncProduct(product.id);
        }

        const generated = await generateProductContent(product.id, { write });
        row.status = write ? 'processed_and_written' : 'previewed';
        row.validation_passed = generated.validation?.passed === true;
        row.requires_review = generated.validation?.requires_review === true;
        row.safe_to_write = generated.validation?.safe_to_write_publishable_preview === true;
        row.manual_content_approval = generated.manual_content_approval === true;
        row.manual_approval_debug = generated.manual_approval_debug || null;
        row.manual_override_eligible = generated.manual_override_eligible === true;
        row.effective_safe_to_write = row.safe_to_write || (row.manual_content_approval && row.manual_override_eligible);
        row.source_hash = generated.source_hash;
        row.model = generated.model;
        row.generation_attempts = generated.generation_attempts || 1;
        row.response_mode = generated.response_mode || 'unknown';
        row.hard_issues = generated.validation?.hard_issues || [];
        row.review_issues = generated.validation?.review_issues || [];
        row.validation_issues = generated.validation?.issues || [];
        row.written_metafields = generated.written_metafields || [];

        successful += 1;
        if (row.requires_review) needsReview += 1;
        if (row.written_metafields.includes('ingredient_story') || row.written_metafields.includes('formula_highlights') || row.written_metafields.includes('product_summary')) written += 1;
      } catch (error) {
        failed += 1;
        row.status = 'failed';
        row.error = error?.message || String(error);
        console.error(`[bulk-content] Failed ${product.id} ${product.title}:`, error);
      }

      results.push(row);

      if (index < products.length - 1 && delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return res.status(200).json({
      stage: write ? '4J-bulk-write-direct-manual-approval' : '4J-bulk-preview-direct-manual-approval',
      writes_to_shopify: write,
      sync_sources: syncSources,
      delay_ms: delayMs,
      total: products.length,
      successful,
      failed,
      products_written: written,
      needs_review: needsReview,
      results,
    });
  } catch (error) {
    console.error('[bulk-content] Bulk generation failed:', error);
    return res.status(500).json({
      error: error?.message || 'Bulk content generation failed',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found', method: req.method, path: req.path });
});

app.listen(config.port, () => {
  console.log(`CorVital metafield automation ${APP_VERSION} listening on port ${config.port}`);
  console.log('Webhook path: /webhooks/products');
  console.log('Content generator: /admin/generate-product-content/:productId');
  console.log('Bulk content generator: /admin/generate-all-products');
});
