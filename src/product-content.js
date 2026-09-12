import { shopifyGraphQL } from './shopify.js';
import { buildApprovedSource, sourceFingerprint } from './source-builder.js';
import { generateGroundedContent } from './claude-content.js';
import {
  validateGeneratedContent,
  buildPublishableContent,
} from './compliance-validator.js';
import { GENERATED_METAFIELD_TYPES } from './content-schema.js';

const CONTENT_PRODUCT_QUERY = `#graphql
  query CorVitalContentProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      metafields(first: 100, namespace: "custom") {
        nodes {
          key
          type
          value
        }
      }
    }
  }
`;

const SET_METAFIELDS = `#graphql
  mutation CorVitalContentMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key type value }
      userErrors { field message code }
    }
  }
`;

function serialize(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function metafieldMap(product) {
  const map = new Map();
  for (const node of product?.metafields?.nodes || []) {
    map.set(node.key, node);
  }
  return map;
}

function metafieldBoolean(product, key) {
  const node = metafieldMap(product).get(key);
  if (!node) return false;
  const value = String(node.value ?? '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

async function writeGeneratedMetafields(productId, content, validation, hash, { manualApproved = false } = {}) {
  const publishableContent = buildPublishableContent(content, validation, {
    manualOverride: manualApproved,
  });

  const normalWrite = Boolean(publishableContent) && validation.safe_to_write_publishable_preview === true;
  const manualWrite = Boolean(publishableContent) && manualApproved === true && !normalWrite;
  const canWrite = normalWrite || manualWrite;

  const status = !canWrite
    ? 'needs_review'
    : manualWrite
      ? 'approved_manual'
      : validation.requires_review
        ? 'approved_with_notes'
        : 'approved';

  const reviewForStorage = {
    ...validation,
    manual_content_approval: manualApproved,
    manual_approval_applied: manualWrite,
  };

  const fields = canWrite
    ? {
        product_summary: publishableContent.product_summary,
        ingredient_story: publishableContent.ingredient_story || [],
        formula_highlights: publishableContent.formula_highlights || [],
        usage_display: publishableContent.usage_display,
        content_status: status,
        content_review: reviewForStorage,
        content_source_hash: hash,
      }
    : {
        content_status: status,
        content_review: reviewForStorage,
        content_source_hash: hash,
      };

  const metafields = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({
      ownerId: productId,
      namespace: 'custom',
      key,
      type: GENERATED_METAFIELD_TYPES[key],
      value: serialize(value),
    }));

  const data = await shopifyGraphQL(SET_METAFIELDS, { metafields });
  const result = data.metafieldsSet;

  if (result.userErrors?.length) {
    throw new Error(`Generated metafield write failed: ${JSON.stringify(result.userErrors)}`);
  }

  return result.metafields;
}

export async function generateProductContent(productGid, { write = false } = {}) {
  const data = await shopifyGraphQL(CONTENT_PRODUCT_QUERY, { id: productGid });
  const product = data?.product;

  if (!product) throw new Error(`Product not found: ${productGid}`);

  const manualApproved = metafieldBoolean(product, 'manual_content_approval');

  const approvedSource = buildApprovedSource(product);
  if (!Object.keys(approvedSource.facts || {}).length) {
    throw new Error(`No factual source metafields found for ${product.title}. Run source sync first.`);
  }

  const hash = sourceFingerprint(approvedSource);
  const generated = await generateGroundedContent(approvedSource);
  const validation = validateGeneratedContent(generated.content, approvedSource);
  const publishablePreview = buildPublishableContent(generated.content, validation, {
    manualOverride: manualApproved,
  });

  let written = [];
  if (write) {
    written = await writeGeneratedMetafields(
      product.id,
      generated.content,
      validation,
      hash,
      { manualApproved }
    );
  }

  return {
    stage: write ? '4I-write-manual-approval' : '4I-preview-manual-approval',
    writes_to_shopify: Boolean(write),
    product: approvedSource.product,
    source_hash: hash,
    manual_content_approval: manualApproved,
    manual_override_eligible: manualApproved && !(validation.hard_issues || []).some((issue) => ['DISEASE_OR_HIGH_RISK_CLAIM', 'INVALID_CLAIM_TYPE'].includes(issue?.code)),
    fact_fields: Object.keys(approvedSource.facts || {}),
    has_source_claim_text: Boolean(approvedSource.source_claim_text),
    approved_claims_count: (approvedSource.approved_claims || []).length,
    serving_derivation: approvedSource.facts?.serving_derivation || null,
    model: generated.model,
    usage: generated.usage,
    generation_attempts: generated.attempts || 1,
    response_mode: generated.response_mode || 'unknown',
    generated: generated.content,
    validation,
    publishable_preview: publishablePreview,
    disclaimer_strategy: 'Global footer disclaimer already present; app appends * to validated health/wellness claims only.',
    written_metafields: written.map((item) => item.key),
  };
}
