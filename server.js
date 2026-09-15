import crypto from 'node:crypto';
import express from 'express';

import { config } from './src/config.js';
import { syncProduct, listAllProducts } from './src/sync-product.js';
import {
  generateProductContent,
  getProductContentAutomationState,
  syncManualApprovalStatus,
} from './src/product-content.js';

const app = express();
const APP_VERSION = 'stage4n-draft-save-approval-gate-2026-09-15';
const seenWebhookIds = new Map();
const productAutomationLocks = new Map();

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

async function runAutomaticProductContent(productGid, topic = 'unknown') {
  if (productAutomationLocks.has(productGid)) {
    console.log(`[auto-content] ${productGid} already processing; skipping duplicate ${topic}`);
    return { skipped: true, reason: 'already_processing' };
  }

  const task = (async () => {
    // Always refresh deterministic source metafields first.
    const sourceSync = await syncProduct(productGid);

    // Cheap state check. No Claude call occurs here.
    const state = await getProductContentAutomationState(productGid);

    if (state.should_generate) {
      console.log(`[auto-content] ${topic} ${productGid} generating once: ${state.reason}`);

      // Stage 4N saves the complete generated draft even when validation says
      // needs_review, then resets Manual content approval to false.
      const generated = await generateProductContent(productGid, { write: true });

      return {
        skipped: false,
        action: 'generated_draft',
        reason: state.reason,
        claude_called: true,
        source_sync: sourceSync,
        state,
        result: {
          validation_passed: generated.validation?.passed === true,
          requires_review: generated.validation?.requires_review === true,
          content_status_after_generation: generated.content_status_after_generation,
          storefront_visibility_after_generation: false,
          written_metafields: generated.written_metafields || [],
        },
      };
    }

    if (state.should_sync_approval) {
      console.log(`[auto-content] ${topic} ${productGid} approval-only sync: ${state.reason}`);

      // IMPORTANT: approval changes do not call Claude.
      const approvalResult = await syncManualApprovalStatus(productGid);

      return {
        skipped: false,
        action: 'approval_sync',
        reason: state.reason,
        claude_called: false,
        source_sync: sourceSync,
        state,
        result: approvalResult,
      };
    }

    console.log(`[auto-content] ${topic} ${productGid} skipped: ${state.reason}`);
    return {
      skipped: true,
      action: 'skip',
      reason: state.reason,
      claude_called: false,
      source_sync: sourceSync,
      state,
    };
  })();

  productAutomationLocks.set(productGid, task);

  try {
    return await task;
  } finally {
    productAutomationLocks.delete(productGid);
  }
}

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'CorVital Plus Metafield Automation',
    status: 'running',
    version: APP_VERSION,
    automaticProductContent: true,
    approvalGateMode: true,
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
    automatic_product_content: true,
    approval_gate_mode: true,
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
      const result = await runAutomaticProductContent(gid, topic);
      console.log(`[webhook] ${topic} -> ${gid}`, result);
      return res.status(200).json({
        ok: true,
        product: gid,
        automatic_content: result,
      });
    } catch (error) {
      console.error(`[webhook] Failed ${topic} ${gid}:`, error);
      return res.status(500).send('Product automation failed');
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

  const write = req.body?.write === true;
  const approvalOnly = req.body?.approval_only === true;
  const productGid = `gid://shopify/Product/${numericProductId}`;

  try {
    if (approvalOnly) {
      const result = await syncManualApprovalStatus(productGid);
      return res.status(200).json({
        stage: '4N-approval-only-no-claude',
        claude_called: false,
        ...result,
      });
    }

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

  const write = req.body?.write === true;
  const syncSources = req.body?.sync_sources !== false;
  const requestedDelay = Number(req.body?.delay_ms ?? 1500);
  const delayMs = Number.isFinite(requestedDelay)
    ? Math.max(500, Math.min(10000, Math.round(requestedDelay)))
    : 1500;

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
        row.manual_content_approval_after_generation = generated.manual_content_approval_after_generation;
        row.content_status_after_generation = generated.content_status_after_generation;
        row.storefront_visibility_after_generation = generated.storefront_visibility_after_generation;
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
        if (
          row.written_metafields.includes('ingredient_story') ||
          row.written_metafields.includes('formula_highlights') ||
          row.written_metafields.includes('product_summary')
        ) written += 1;
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
      stage: write ? '4N-bulk-write-drafts-approval-gate' : '4N-bulk-preview-drafts-approval-gate',
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

const port = config.port || process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`CorVital automation ${APP_VERSION} listening on port ${port}`);
});

export default app;
