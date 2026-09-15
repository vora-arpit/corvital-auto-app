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

      manualContentApproval: metafield(
        namespace: "custom"
        key: "manual_content_approval"
      ) {
        key
        namespace
        type
        value
      }

      contentStatus: metafield(namespace: "custom", key: "content_status") {
        key
        type
        value
      }

      contentReview: metafield(namespace: "custom", key: "content_review") {
        key
        type
        value
      }

      contentSourceHash: metafield(namespace: "custom", key: "content_source_hash") {
        key
        type
        value
      }

      productSummary: metafield(namespace: "custom", key: "product_summary") {
        key
        type
        value
      }

      ingredientStory: metafield(namespace: "custom", key: "ingredient_story") {
        key
        type
        value
      }

      formulaHighlights: metafield(namespace: "custom", key: "formula_highlights") {
        key
        type
        value
      }

      usageDisplay: metafield(namespace: "custom", key: "usage_display") {
        key
        type
        value
      }

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

function parseBooleanValue(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function parseJsonValue(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function hasMeaningfulMetafield(node) {
  if (!node || node.value === null || node.value === undefined) return false;
  const raw = String(node.value).trim();
  if (!raw || raw === 'null' || raw === '[]' || raw === '{}') return false;
  return true;
}

async function fetchContentProduct(productGid) {
  const data = await shopifyGraphQL(CONTENT_PRODUCT_QUERY, { id: productGid });
  const product = data?.product;
  if (!product) throw new Error(`Product not found: ${productGid}`);
  return product;
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

/**
 * Cheap preflight used by the Shopify product webhook.
 * It does NOT call Claude.
 *
 * It triggers content generation only when:
 * 1) this product has never been generated before,
 * 2) source facts changed (source hash differs),
 * 3) a previously reviewed product was manually approved by the merchant, or
 * 4) an approved product is missing its generated display metafields.
 *
 * This prevents price/inventory/image/metafield update webhooks from wasting
 * Claude credits and prevents generated-metafield writes from causing loops.
 */
export async function getProductContentAutomationState(productGid) {
  const product = await fetchContentProduct(productGid);
  const approvedSource = buildApprovedSource(product);
  const factCount = Object.keys(approvedSource.facts || {}).length;

  if (!factCount) {
    return {
      should_generate: false,
      reason: 'no_source_facts',
      product: approvedSource.product,
      manual_content_approval: parseBooleanValue(product?.manualContentApproval?.value),
      content_status: String(product?.contentStatus?.value || ''),
      current_source_hash: null,
      stored_source_hash: String(product?.contentSourceHash?.value || ''),
    };
  }

  const currentHash = sourceFingerprint(approvedSource);
  const storedHash = String(product?.contentSourceHash?.value || '').trim();
  const contentStatus = String(product?.contentStatus?.value || '').trim();
  const manualApproved = parseBooleanValue(product?.manualContentApproval?.value);
  const previousReview = parseJsonValue(product?.contentReview?.value, {}) || {};

  // Track generated display fields individually. Using `.some(...)` here was too
  // permissive: a populated product_summary could make the product look complete
  // even when ingredient_story was [], formula_highlights was [], and usage_display
  // was blank. That caused approved products to be incorrectly skipped as up_to_date.
  const generatedFieldState = {
    product_summary: hasMeaningfulMetafield(product?.productSummary),
    ingredient_story: hasMeaningfulMetafield(product?.ingredientStory),
    formula_highlights: hasMeaningfulMetafield(product?.formulaHighlights),
    usage_display: hasMeaningfulMetafield(product?.usageDisplay),
  };

  const hasGeneratedContent = Object.values(generatedFieldState).some(Boolean);

  // Require only fields that the source can reasonably support. This avoids
  // regeneration loops on products that truly lack usage or formula data.
  const requiredGeneratedFields = ['product_summary'];

  const sourceFacts = approvedSource.facts || {};
  const ingredientFacts = Array.isArray(sourceFacts.ingredient_highlights)
    ? sourceFacts.ingredient_highlights
    : [];

  if (ingredientFacts.length > 0) {
    requiredGeneratedFields.push('ingredient_story');
  }

  if (approvedSource.has_source_claim_text === true || approvedSource.source_claim_text) {
    requiredGeneratedFields.push('formula_highlights');
  }

  if (sourceFacts.suggested_use || sourceFacts.serving_size || sourceFacts.servings_per_container) {
    requiredGeneratedFields.push('usage_display');
  }

  const missingGeneratedFields = requiredGeneratedFields.filter(
    (key) => generatedFieldState[key] !== true,
  );
  const hasCompleteGeneratedContent = missingGeneratedFields.length === 0;

  const approvedStatuses = new Set(['approved', 'approved_manual', 'approved_with_notes']);
  const sourceChanged = Boolean(storedHash) && storedHash !== currentHash;
  const neverGenerated = !storedHash && !contentStatus;

  // When the app previously stored needs_review with manual approval = false,
  // turning the Shopify boolean to true is the signal to retry automatically.
  // If manual approval was already tried and still could not be applied (for
  // example a non-bypassable disease claim), do not loop on every webhook.
  const manualApprovalJustGranted =
    manualApproved === true &&
    contentStatus === 'needs_review' &&
    previousReview?.manual_content_approval !== true;

  const approvedButMissingDisplayContent =
    approvedStatuses.has(contentStatus) && !hasCompleteGeneratedContent;

  let reason = 'up_to_date';
  let shouldGenerate = false;

  if (neverGenerated) {
    shouldGenerate = true;
    reason = 'new_product_or_never_generated';
  } else if (sourceChanged) {
    shouldGenerate = true;
    reason = 'source_changed';
  } else if (manualApprovalJustGranted) {
    shouldGenerate = true;
    reason = 'manual_approval_granted';
  } else if (approvedButMissingDisplayContent) {
    shouldGenerate = true;
    reason = 'approved_content_missing';
  }

  return {
    should_generate: shouldGenerate,
    reason,
    product: approvedSource.product,
    manual_content_approval: manualApproved,
    content_status: contentStatus || null,
    has_generated_content: hasGeneratedContent,
    has_complete_generated_content: hasCompleteGeneratedContent,
    generated_field_state: generatedFieldState,
    required_generated_fields: requiredGeneratedFields,
    missing_generated_fields: missingGeneratedFields,
    current_source_hash: currentHash,
    stored_source_hash: storedHash || null,
    source_changed: sourceChanged,
    previous_manual_approval_seen: previousReview?.manual_content_approval === true,
    previous_manual_approval_applied: previousReview?.manual_approval_applied === true,
  };
}

export async function generateProductContent(productGid, { write = false } = {}) {
  const product = await fetchContentProduct(productGid);

  const manualApprovalRaw = String(product?.manualContentApproval?.value ?? '').trim();
  const manualApproved = parseBooleanValue(manualApprovalRaw);

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

  const nonBypassable = (validation.hard_issues || []).some((issue) =>
    ['DISEASE_OR_HIGH_RISK_CLAIM', 'INVALID_CLAIM_TYPE'].includes(issue?.code)
  );

  return {
    stage: write ? '4K-write-auto-webhook-manual-approval' : '4K-preview-auto-webhook-manual-approval',
    writes_to_shopify: Boolean(write),
    product: approvedSource.product,
    source_hash: hash,
    manual_approval_debug: {
      found: Boolean(product?.manualContentApproval),
      key: product?.manualContentApproval?.key || null,
      namespace: product?.manualContentApproval?.namespace || null,
      type: product?.manualContentApproval?.type || null,
      raw_value: product?.manualContentApproval?.value ?? null,
    },
    manual_content_approval: manualApproved,
    manual_override_eligible: manualApproved && !nonBypassable,
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
