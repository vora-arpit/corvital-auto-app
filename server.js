import crypto from 'node:crypto';
import express from 'express';

import { config } from './src/config.js';
import { syncProduct } from './src/sync-product.js';

const app = express();

/*
  Used only for short-term duplicate webhook protection.
  Note: On Vercel this Map is not guaranteed to persist between invocations,
  but Shopify webhook IDs plus idempotent metafield syncing give us another
  layer of protection.
*/
const seenWebhookIds = new Map();

/* ============================================================
   SHOPIFY WEBHOOK HMAC VERIFICATION
============================================================ */

function verifyWithSecret(rawBody, receivedHmac, secret) {
  if (!receivedHmac || !secret || !Buffer.isBuffer(rawBody)) {
    return false;
  }

  try {
    const calculatedHmac = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    /*
      Decode both Base64 values before timingSafeEqual.
      This avoids comparing encoded text representations.
    */
    const calculatedBuffer = Buffer.from(calculatedHmac, 'base64');
    const receivedBuffer = Buffer.from(String(receivedHmac).trim(), 'base64');

    if (calculatedBuffer.length !== receivedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(calculatedBuffer, receivedBuffer);
  } catch (error) {
    console.error('[webhook] HMAC verification error:', error);
    return false;
  }
}

function validWebhookHmac(rawBody, receivedHmac) {
  /*
    Primary/new secret.
  */
  if (
    verifyWithSecret(
      rawBody,
      receivedHmac,
      config.clientSecret
    )
  ) {
    return true;
  }

  /*
    Optional OLD secret.

    Keep this temporarily if you recently rotated your Shopify client secret.
    Add SHOPIFY_OLD_CLIENT_SECRET in Vercel.

    Once all webhook signatures are being generated using the new secret,
    remove the old environment variable.
  */
  const oldSecret = process.env.SHOPIFY_OLD_CLIENT_SECRET;

  if (
    oldSecret &&
    verifyWithSecret(
      rawBody,
      receivedHmac,
      oldSecret
    )
  ) {
    console.log(
      '[webhook] HMAC validated using OLD client secret. ' +
      'Remove SHOPIFY_OLD_CLIENT_SECRET after Shopify finishes secret rotation.'
    );

    return true;
  }

  return false;
}

/* ============================================================
   DUPLICATE WEBHOOK PROTECTION
============================================================ */

function rememberWebhook(id) {
  if (!id) return false;

  const now = Date.now();
  const ttl = 10 * 60 * 1000;

  for (const [key, timestamp] of seenWebhookIds) {
    if (now - timestamp > ttl) {
      seenWebhookIds.delete(key);
    }
  }

  if (seenWebhookIds.has(id)) {
    return true;
  }

  seenWebhookIds.set(id, now);

  return false;
}

/* ============================================================
   HEALTH CHECK
============================================================ */

app.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'corvital-metafield-automation',
    timestamp: new Date().toISOString()
  });
});

/* ============================================================
   SHOPIFY PRODUCT WEBHOOK

   IMPORTANT:
   express.raw() MUST be used here.
   Do not put express.json() before this route.
============================================================ */

app.post(
  '/webhooks/products',

  express.raw({
    type: 'application/json',
    limit: '2mb'
  }),

  async (req, res) => {
    const rawBody = req.body;

    const hmac =
      req.get('X-Shopify-Hmac-Sha256') || '';

    const topic =
      req.get('X-Shopify-Topic') || 'unknown';

    const webhookId =
      req.get('X-Shopify-Webhook-Id') || '';

    const shopDomain =
      req.get('X-Shopify-Shop-Domain') || '';

    console.log(
      `[webhook] Received topic=${topic} ` +
      `shop=${shopDomain || 'unknown'} ` +
      `id=${webhookId || 'none'}`
    );

    /* --------------------------------------------------------
       Validate raw request body
    -------------------------------------------------------- */

    if (!Buffer.isBuffer(rawBody)) {
      console.error(
        '[webhook] Request body was not a raw Buffer. ' +
        'HMAC verification cannot be performed safely.'
      );

      return res
        .status(400)
        .send('Raw body required');
    }

    /* --------------------------------------------------------
       Verify Shopify signature
    -------------------------------------------------------- */

    if (!validWebhookHmac(rawBody, hmac)) {
      console.warn(
        `[webhook] Invalid HMAC for topic=${topic}`
      );

      return res
        .status(401)
        .send('Invalid HMAC');
    }

    console.log(
      `[webhook] HMAC valid for topic=${topic}`
    );

    /* --------------------------------------------------------
       Ignore duplicate delivery
    -------------------------------------------------------- */

    if (rememberWebhook(webhookId)) {
      console.log(
        `[webhook] Duplicate ignored id=${webhookId}`
      );

      return res
        .status(200)
        .send('Duplicate');
    }

    /* --------------------------------------------------------
       Parse Shopify JSON only AFTER HMAC validation
    -------------------------------------------------------- */

    let payload;

    try {
      payload = JSON.parse(
        rawBody.toString('utf8')
      );
    } catch (error) {
      console.error(
        '[webhook] Invalid JSON payload:',
        error
      );

      return res
        .status(400)
        .send('Invalid JSON');
    }

    /* --------------------------------------------------------
       Resolve Shopify Product GID
    -------------------------------------------------------- */

    const gid =
      payload.admin_graphql_api_id ||
      (
        payload.id
          ? `gid://shopify/Product/${payload.id}`
          : null
      );

    if (!gid) {
      console.warn(
        `[webhook] ${topic} contained no product ID`
      );

      /*
        Return 200 so Shopify does not repeatedly retry
        an unusable payload.
      */
      return res
        .status(200)
        .send('No product id');
    }

    /* --------------------------------------------------------
       Process BEFORE finishing Vercel invocation.

       Do not use setImmediate() here.
       Vercel/serverless may stop execution after response.
    -------------------------------------------------------- */

    try {
      console.log(
        `[webhook] Processing ${topic} -> ${gid}`
      );

      const result = await syncProduct(gid);

      console.log(
        `[webhook] Completed ${topic} -> ${gid}`
      );

      if (result) {
        console.log(
          '[webhook] Sync result:',
          result
        );
      }

      return res
        .status(200)
        .send('OK');

    } catch (error) {
      console.error(
        `[webhook] Failed ${topic} ${gid}:`,
        error
      );

      /*
        500 tells Shopify the webhook failed.
        Shopify can retry delivery.
      */
      return res
        .status(500)
        .send('Product sync failed');
    }
  }
);

/* ============================================================
   JSON PARSER FOR ANY FUTURE NON-WEBHOOK ROUTES

   IMPORTANT:
   This is deliberately AFTER the webhook route.
============================================================ */

app.use(express.json());

/* ============================================================
   ROOT INFO
============================================================ */

app.get('/', (_req, res) => {
  res.status(200).json({
    service: 'CorVital Plus Metafield Automation',
    status: 'running',
    health: '/health',
    webhook: '/webhooks/products'
  });
});

/* ============================================================
   START SERVER
============================================================ */

app.listen(config.port, () => {
  console.log(
    `CorVital metafield automation listening on port ${config.port}`
  );

  console.log(
    `Health: http://localhost:${config.port}/health`
  );

  console.log(
    'Webhook path: /webhooks/products'
  );
});