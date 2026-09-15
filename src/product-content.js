import { shopifyGraphQL } from './shopify.js';
import { buildApprovedSource, sourceFingerprint } from './source-builder.js';
import { generateGroundedContent } from './claude-content.js';
import { validateGeneratedContent } from './compliance-validator.js';
import { GENERATED_METAFIELD_TYPES } from './content-schema.js';

const CONTENT_PRODUCT_QUERY = `#graphql
  query CorVitalContentProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle

      manualContentApproval: metafield(namespace: "custom", key: "manual_content_approval") {
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

const NON_BYPASSABLE_CODES = new Set([
  'DISEASE_OR_HIGH_RISK_CLAIM',
  'INVALID_CLAIM_TYPE',
]);

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

function appendClaimAsterisk(text) {
  const value = String(text || '').trim();
  if (!value) return value;
  if (/\*\s*[.!?]?$/.test(value)) return value;

  const punctuation = value.match(/([.!?])$/);
  if (punctuation) {
    return `${value.slice(0, -1)}*${punctuation[1]}`;
  }
  return `${value}*`;
}

function reviewDraftTextObject(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };

  if (copy.claim_type === 'source_claim' || copy.claim_type === 'approved_claim') {
    // For the review draft, prefer the source quote rather than Claude's paraphrase.
    // The merchant reviews exactly what can later appear on the storefront.
    const sourceText = String(copy.source_quote || '').trim();
    copy.text = appendClaimAsterisk(sourceText || copy.text);
  }

  return copy;
}

/**
 * Build a complete review draft regardless of normal validation result.
 * This is intentionally stored in Shopify but hidden from the storefront until
 * custom.manual_content_approval is true.
 */
function buildReviewDraft(content) {
  const output = JSON.parse(JSON.stringify(content || {}));

  if (output.product_summary) {
    output.product_summary = reviewDraftTextObject(output.product_summary);
  }

  if (Array.isArray(output.ingredient_story)) {
    output.ingredient_story = output.ingredient_story.map((story) => ({
      ...story,
      what_it_is: reviewDraftTextObject(story?.what_it_is),
      why_in_formula: reviewDraftTextObject(story?.why_in_formula),
    }));
  } else {
    output.ingredient_story = [];
  }

  if (Array.isArray(output.formula_highlights)) {
    output.formula_highlights = output.formula_highlights.map(reviewDraftTextObject);
  } else {
    output.formula_highlights = [];
  }

  if (!output.usage_display) output.usage_display = null;

  return output;
}

function hasNonBypassableIssue(validation) {
  return (validation?.hard_issues || []).some((issue) =>
    NON_BYPASSABLE_CODES.has(issue?.code)
  );
}

async function fetchContentProduct(productGid) {
  const data = await shopifyGraphQL(CONTENT_PRODUCT_QUERY, { id: productGid });
  const product = data?.product;
  if (!product) throw new Error(`Product not found: ${productGid}`);
  return product;
}

async function setMetafields(productId, fields) {
  const metafields = Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => ({
      ownerId: productId,
      namespace: 'custom',
      key,
      type: key === 'manual_content_approval' ? 'boolean' : GENERATED_METAFIELD_TYPES[key],
      value: serialize(value),
    }));

  if (!metafields.length) return [];

  const data = await shopifyGraphQL(SET_METAFIELDS, { metafields });
  const result = data.metafieldsSet;

  if (result.userErrors?.length) {
    throw new Error(`Generated metafield write failed: ${JSON.stringify(result.userErrors)}`);
  }

  return result.metafields || [];
}

/**
 * Save a generated draft every time Claude runs.
 *
 * Important Stage 4N behavior:
 * - Generated display fields are saved even when validation says needs_review.
 * - Every fresh generation resets manual_content_approval to false.
 * - Storefront visibility is controlled later by the Shopify boolean, not by
 *   another Claude call.
 */
async function writeGeneratedDraft(productId, content, validation, hash) {
  const draft = buildReviewDraft(content);
  const blocked = hasNonBypassableIssue(validation);

  const status = blocked
    ? 'blocked'
    : validation?.passed === true
      ? 'awaiting_approval'
      : 'needs_review';

  const reviewForStorage = {
    ...validation,
    draft_saved: true,
    manual_content_approval: false,
    approval_required_for_storefront: true,
  };

  const fields = {
    product_summary: draft.product_summary || null,
    ingredient_story: draft.ingredient_story || [],
    formula_highlights: draft.formula_highlights || [],
    usage_display: draft.usage_display || null,
    content_status: status,
    content_review: reviewForStorage,
    content_source_hash: hash,
    manual_content_approval: false,
  };

  return setMetafields(productId, fields);
}

/**
 * No-Claude approval sync.
 * Called after the merchant toggles Manual content approval in Shopify.
 */
export async function syncManualApprovalStatus(productGid) {
  const product = await fetchContentProduct(productGid);
  const manualApproved = parseBooleanValue(product?.manualContentApproval?.value);
  const review = parseJsonValue(product?.contentReview?.value, {}) || {};
  const blocked = hasNonBypassableIssue(review);

  let status;
  if (blocked) {
    status = 'blocked';
  } else if (manualApproved) {
    status = 'approved_manual';
  } else if (review?.passed === true) {
    status = 'awaiting_approval';
  } else {
    status = 'needs_review';
  }

  const effectiveManualApproval = blocked ? false : manualApproved;

  const fields = {
    content_status: status,
    content_review: {
      ...review,
      manual_content_approval: effectiveManualApproval,
      approval_required_for_storefront: true,
    },
  };

  // A non-bypassable disease/high-risk issue can never be made visible by the
  // approval switch. Reset the boolean so Shopify accurately reflects that.
  if (blocked && manualApproved) {
    fields.manual_content_approval = false;
  }

  const written = await setMetafields(product.id, fields);

  return {
    product: { id: product.id, title: product.title, handle: product.handle },
    manual_content_approval: blocked ? false : manualApproved,
    content_status: status,
    blocked,
    written_metafields: written.map((item) => item.key),
  };
}

/**
 * Cheap webhook preflight. It never calls Claude.
 *
 * Claude should run only when:
 * 1) product has never generated content, or
 * 2) authoritative source hash changed.
 *
 * Manual approval changes NEVER trigger Claude in Stage 4N.
 */
export async function getProductContentAutomationState(productGid) {
  const product = await fetchContentProduct(productGid);
  const approvedSource = buildApprovedSource(product);
  const factCount = Object.keys(approvedSource.facts || {}).length;
  const manualApproved = parseBooleanValue(product?.manualContentApproval?.value);
  const contentStatus = String(product?.contentStatus?.value || '').trim();
  const storedHash = String(product?.contentSourceHash?.value || '').trim();

  if (!factCount) {
    return {
      action: 'skip',
      should_generate: false,
      should_sync_approval: false,
      reason: 'no_source_facts',
      product: approvedSource.product,
      manual_content_approval: manualApproved,
      content_status: contentStatus || null,
      current_source_hash: null,
      stored_source_hash: storedHash || null,
    };
  }

  const currentHash = sourceFingerprint(approvedSource);
  const neverGenerated = !storedHash;
  const sourceChanged = Boolean(storedHash) && storedHash !== currentHash;
  const previousReview = parseJsonValue(product?.contentReview?.value, {}) || {};
  const previousManualApproval = previousReview?.manual_content_approval === true;
  const approvalChanged = previousManualApproval !== manualApproved;

  if (neverGenerated) {
    return {
      action: 'generate',
      should_generate: true,
      should_sync_approval: false,
      reason: 'new_product_or_never_generated',
      product: approvedSource.product,
      manual_content_approval: manualApproved,
      content_status: contentStatus || null,
      current_source_hash: currentHash,
      stored_source_hash: null,
      source_changed: false,
      approval_changed: approvalChanged,
    };
  }

  if (sourceChanged) {
    return {
      action: 'generate',
      should_generate: true,
      should_sync_approval: false,
      reason: 'source_changed',
      product: approvedSource.product,
      manual_content_approval: manualApproved,
      content_status: contentStatus || null,
      current_source_hash: currentHash,
      stored_source_hash: storedHash,
      source_changed: true,
      approval_changed: approvalChanged,
    };
  }

  if (approvalChanged) {
    return {
      action: 'approval_sync',
      should_generate: false,
      should_sync_approval: true,
      reason: manualApproved ? 'manual_approval_enabled' : 'manual_approval_disabled',
      product: approvedSource.product,
      manual_content_approval: manualApproved,
      content_status: contentStatus || null,
      current_source_hash: currentHash,
      stored_source_hash: storedHash,
      source_changed: false,
      approval_changed: true,
    };
  }

  return {
    action: 'skip',
    should_generate: false,
    should_sync_approval: false,
    reason: 'up_to_date',
    product: approvedSource.product,
    manual_content_approval: manualApproved,
    content_status: contentStatus || null,
    current_source_hash: currentHash,
    stored_source_hash: storedHash,
    source_changed: false,
    approval_changed: false,
  };
}

export async function generateProductContent(productGid, { write = false } = {}) {
  const product = await fetchContentProduct(productGid);
  const approvedSource = buildApprovedSource(product);

  if (!Object.keys(approvedSource.facts || {}).length) {
    throw new Error(`No factual source metafields found for ${product.title}. Run source sync first.`);
  }

  const hash = sourceFingerprint(approvedSource);
  const generated = await generateGroundedContent(approvedSource);
  const validation = validateGeneratedContent(generated.content, approvedSource);
  const reviewDraft = buildReviewDraft(generated.content);

  let written = [];
  if (write) {
    written = await writeGeneratedDraft(
      product.id,
      generated.content,
      validation,
      hash,
    );
  }

  return {
    stage: write ? '4N-write-draft-approval-gate' : '4N-preview-draft-approval-gate',
    writes_to_shopify: Boolean(write),
    product: approvedSource.product,
    source_hash: hash,
    manual_content_approval_before_generation: parseBooleanValue(product?.manualContentApproval?.value),
    manual_content_approval_after_generation: write ? false : null,
    fact_fields: Object.keys(approvedSource.facts || {}),
    has_source_claim_text: Boolean(approvedSource.source_claim_text),
    approved_claims_count: (approvedSource.approved_claims || []).length,
    serving_derivation: approvedSource.facts?.serving_derivation || null,
    model: generated.model,
    usage: generated.usage,
    generation_attempts: generated.attempts || 1,
    response_mode: generated.response_mode || 'unknown',
    generated: generated.content,
    review_draft: reviewDraft,
    validation,
    content_status_after_generation: hasNonBypassableIssue(validation)
      ? 'blocked'
      : validation?.passed === true
        ? 'awaiting_approval'
        : 'needs_review',
    storefront_visibility_after_generation: false,
    disclaimer_strategy: 'Global footer disclaimer already present; app appends * to source-backed health/wellness claims in the stored review draft.',
    written_metafields: written.map((item) => item.key),
  };
}
