import crypto from 'node:crypto';
import express from 'express';

import { config } from './src/config.js';

import {
  syncProduct,
  generateProductCapsuleDraft
} from './src/sync-product.js';

const app = express();

/**
 * Short-term duplicate webhook protection.
 *
 * Note:
 * On Vercel this Map is not guaranteed to persist between
 * different serverless invocations, but it is still useful
 * during warm invocations.
 *
 * Our syncProduct() logic should also remain idempotent.
 */
const seenWebhookIds = new Map();


/* ============================================================
   SHOPIFY WEBHOOK HMAC VERIFICATION
============================================================ */

function verifyWithSecret(
  rawBody,
  receivedHmac,
  secret
) {
  if (
    !receivedHmac ||
    !secret ||
    !Buffer.isBuffer(rawBody)
  ) {
    return false;
  }

  try {
    const calculatedHmac = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    /*
      Decode both Base64 signatures before comparing them.
    */
    const calculatedBuffer =
      Buffer.from(
        calculatedHmac,
        'base64'
      );

    const receivedBuffer =
      Buffer.from(
        String(receivedHmac).trim(),
        'base64'
      );

    if (
      calculatedBuffer.length !==
      receivedBuffer.length
    ) {
      return false;
    }

    return crypto.timingSafeEqual(
      calculatedBuffer,
      receivedBuffer
    );

  } catch (error) {
    console.error(
      '[webhook] HMAC verification error:',
      error
    );

    return false;
  }
}


function validWebhookHmac(
  rawBody,
  receivedHmac
) {
  /*
    Primary / current Shopify client secret.
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
    Optional old secret.

    Keep this only while Shopify secret rotation is still
    relevant. Later you can remove this environment variable.
  */
  const oldSecret =
    process.env.SHOPIFY_OLD_CLIENT_SECRET;

  if (
    oldSecret &&
    verifyWithSecret(
      rawBody,
      receivedHmac,
      oldSecret
    )
  ) {
    console.log(
      '[webhook] HMAC validated using OLD client secret.'
    );

    return true;
  }

  return false;
}


/* ============================================================
   DUPLICATE WEBHOOK PROTECTION
============================================================ */

function rememberWebhook(id) {
  if (!id) {
    return false;
  }

  const now = Date.now();

  const ttl =
    10 * 60 * 1000;

  for (
    const [key, timestamp]
    of seenWebhookIds
  ) {
    if (
      now - timestamp > ttl
    ) {
      seenWebhookIds.delete(key);
    }
  }

  if (
    seenWebhookIds.has(id)
  ) {
    return true;
  }

  seenWebhookIds.set(
    id,
    now
  );

  return false;
}


/* ============================================================
   HEALTH CHECK
============================================================ */

app.get(
  '/health',

  (_req, res) => {
    res
      .status(200)
      .json({
        ok: true,
        service:
          'corvital-metafield-automation',
        timestamp:
          new Date().toISOString()
      });
  }
);


/* ============================================================
   SHOPIFY PRODUCT WEBHOOK

   IMPORTANT:
   express.raw() MUST remain here.

   Do NOT put express.json() above this webhook route,
   otherwise Shopify HMAC validation can fail.
============================================================ */

app.post(
  '/webhooks/products',

  express.raw({
    type: 'application/json',
    limit: '2mb'
  }),

  async (req, res) => {

    const rawBody =
      req.body;

    const hmac =
      req.get(
        'X-Shopify-Hmac-Sha256'
      ) || '';

    const topic =
      req.get(
        'X-Shopify-Topic'
      ) || 'unknown';

    const webhookId =
      req.get(
        'X-Shopify-Webhook-Id'
      ) || '';

    const shopDomain =
      req.get(
        'X-Shopify-Shop-Domain'
      ) || '';


    console.log(
      `[webhook] Received topic=${topic} ` +
      `shop=${shopDomain || 'unknown'} ` +
      `id=${webhookId || 'none'}`
    );


    /* --------------------------------------------------------
       Validate raw body
    -------------------------------------------------------- */

    if (
      !Buffer.isBuffer(rawBody)
    ) {
      console.error(
        '[webhook] Request body was not a raw Buffer.'
      );

      return res
        .status(400)
        .send(
          'Raw body required'
        );
    }


    /* --------------------------------------------------------
       Verify Shopify signature
    -------------------------------------------------------- */

    if (
      !validWebhookHmac(
        rawBody,
        hmac
      )
    ) {
      console.warn(
        `[webhook] Invalid HMAC for topic=${topic}`
      );

      return res
        .status(401)
        .send(
          'Invalid HMAC'
        );
    }


    console.log(
      `[webhook] HMAC valid for topic=${topic}`
    );


    /* --------------------------------------------------------
       Ignore duplicate delivery
    -------------------------------------------------------- */

    if (
      rememberWebhook(
        webhookId
      )
    ) {
      console.log(
        `[webhook] Duplicate ignored id=${webhookId}`
      );

      return res
        .status(200)
        .send(
          'Duplicate'
        );
    }


    /* --------------------------------------------------------
       Parse JSON only AFTER HMAC validation
    -------------------------------------------------------- */

    let payload;

    try {
      payload =
        JSON.parse(
          rawBody.toString(
            'utf8'
          )
        );

    } catch (error) {
      console.error(
        '[webhook] Invalid JSON payload:',
        error
      );

      return res
        .status(400)
        .send(
          'Invalid JSON'
        );
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
        Return 200 so Shopify does not continuously retry
        a payload that contains no usable product ID.
      */
      return res
        .status(200)
        .send(
          'No product id'
        );
    }


    /* --------------------------------------------------------
       Process product sync
    -------------------------------------------------------- */

    try {
      console.log(
        `[webhook] Processing ${topic} -> ${gid}`
      );


      const result =
        await syncProduct(
          gid
        );


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
        .send(
          'OK'
        );


    } catch (error) {
      console.error(
        `[webhook] Failed ${topic} ${gid}:`,
        error
      );


      /*
        Return 500 so Shopify knows processing failed.
      */
      return res
        .status(500)
        .send(
          'Product sync failed'
        );
    }
  }
);


/* ============================================================
   NORMAL JSON PARSER

   IMPORTANT:
   This must stay AFTER the Shopify webhook route.
============================================================ */

app.use(
  express.json({
    limit: '2mb'
  })
);


/* ============================================================
   MANUAL CAPSULE AI GENERATION
   ------------------------------------------------------------
   Stage 3 test endpoint

   Example:
   POST /admin/generate-capsule/1234567890

   Required header:
   X-Capsule-Generator-Secret
============================================================ */

app.post(
  '/admin/generate-capsule/:productId',

  async (req, res) => {

    /* --------------------------------------------------------
       Verify private generator secret
    -------------------------------------------------------- */

    const suppliedSecret =
      req.get(
        'X-Capsule-Generator-Secret'
      );


    const expectedSecret =
      process.env
        .CAPSULE_GENERATOR_SECRET;


    if (
      !expectedSecret ||
      !suppliedSecret
    ) {
      console.warn(
        '[capsule-ai] Unauthorized request: missing generator secret.'
      );

      return res
        .status(401)
        .json({
          error:
            'Unauthorized'
        });
    }


    /*
      Constant-time comparison for our private endpoint secret.
    */
    const suppliedBuffer =
      Buffer.from(
        String(
          suppliedSecret
        ),
        'utf8'
      );

    const expectedBuffer =
      Buffer.from(
        String(
          expectedSecret
        ),
        'utf8'
      );


    if (
      suppliedBuffer.length !==
      expectedBuffer.length
    ) {
      console.warn(
        '[capsule-ai] Unauthorized request: invalid generator secret.'
      );

      return res
        .status(401)
        .json({
          error:
            'Unauthorized'
        });
    }


    if (
      !crypto.timingSafeEqual(
        suppliedBuffer,
        expectedBuffer
      )
    ) {
      console.warn(
        '[capsule-ai] Unauthorized request: invalid generator secret.'
      );

      return res
        .status(401)
        .json({
          error:
            'Unauthorized'
        });
    }


    /* --------------------------------------------------------
       Validate Shopify product ID
    -------------------------------------------------------- */

    const numericProductId =
      String(
        req.params.productId ||
        ''
      )
        .trim();


    if (
      !/^\d+$/.test(
        numericProductId
      )
    ) {
      return res
        .status(400)
        .json({
          error:
            'Invalid Shopify product ID'
        });
    }


    const productGid =
      `gid://shopify/Product/${numericProductId}`;


    /* --------------------------------------------------------
       Generate capsule draft
    -------------------------------------------------------- */

    try {
      console.log(
        `[capsule-ai] Manual generation requested for ${productGid}`
      );


      const result =
        await generateProductCapsuleDraft(
          productGid
        );


      console.log(
        `[capsule-ai] Manual generation completed for ${productGid}`
      );


      return res
        .status(200)
        .json(
          result
        );


    } catch (error) {
      console.error(
        `[capsule-ai] Generation failed for ${productGid}:`,
        error
      );


      return res
        .status(500)
        .json({
          error:
            error?.message ||
            'Capsule generation failed'
        });
    }
  }
);


/* ============================================================
   ROOT INFO
============================================================ */

app.get(
  '/',

  (_req, res) => {
    res
      .status(200)
      .json({
        service:
          'CorVital Plus Metafield Automation',

        status:
          'running',

        health:
          '/health',

        webhook:
          '/webhooks/products',

        capsuleGenerator:
          '/admin/generate-capsule/:productId'
      });
  }
);


/* ============================================================
   404
============================================================ */

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        error:
          'Route not found',

        path:
          req.path
      });
  }
);


/* ============================================================
   START SERVER
============================================================ */

app.listen(
  config.port,

  () => {
    console.log(
      `CorVital metafield automation listening on port ${config.port}`
    );

    console.log(
      `Health: http://localhost:${config.port}/health`
    );

    console.log(
      'Webhook path: /webhooks/products'
    );

    console.log(
      'Capsule generator path: /admin/generate-capsule/:productId'
    );
  }
);