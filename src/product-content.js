import { shopifyGraphQL } from './shopify.js';
import { buildApprovedSource, sourceFingerprint } from './source-builder.js';
import { generateGroundedContent } from './claude-content.js';
import {
  validateGeneratedContent,
  stripReviewClaims,
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

async function writeGeneratedMetafields(productId, content, validation, hash) {
  const publishableContent = stripReviewClaims(content, validation);

  const status = !validation.safe_to_write
    ? 'needs_review'
    : validation.requires_review
      ? 'approved_facts_claims_held'
      : 'approved';

  // Hard validation problems: do not write generated presentation content.
  // We still write the review/status/hash so the issue is visible internally.
  const fields = validation.safe_to_write
    ? {
        product_summary: publishableContent.product_summary,
        ingredient_story: publishableContent.ingredient_story || [],
        formula_highlights: publishableContent.formula_highlights || [],
        usage_display: publishableContent.usage_display,
        content_status: status,
        content_review: validation,
        content_source_hash: hash,
      }
    : {
        content_status: status,
        content_review: validation,
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

  const approvedSource = buildApprovedSource(product);
  if (!Object.keys(approvedSource.sources).length) {
    throw new Error(`No approved source metafields found for ${product.title}. Run source sync first.`);
  }

  const hash = sourceFingerprint(approvedSource);
  const generated = await generateGroundedContent(approvedSource);
  const validation = validateGeneratedContent(generated.content, approvedSource);
  const publishablePreview = validation.safe_to_write
    ? stripReviewClaims(generated.content, validation)
    : null;

  let written = [];
  if (write) {
    written = await writeGeneratedMetafields(
      product.id,
      generated.content,
      validation,
      hash
    );
  }

  return {
    stage: write ? '4B-write-enabled-strict' : '4A-preview-strict',
    writes_to_shopify: Boolean(write),
    product: approvedSource.product,
    source_hash: hash,
    source_fields: Object.keys(approvedSource.sources),
    model: generated.model,
    usage: generated.usage,
    generated: generated.content,
    validation,
    publishable_preview: publishablePreview,
    written_metafields: written.map((item) => item.key),
  };
}
