import crypto from 'node:crypto';
import { deriveServingInfo } from './serving-utils.js';

const RAW_SOURCE_KEYS = [
  'description_clean',
  'ingredients',
  'other_ingredients',
  'contains',
  'manufacturer_country',
  'product_amount',
  'gross_weight',
  'serving_size',
  'servings_per_container',
  'serving_derivation',
  'suggested_use',
  'caution',
  'iron_warning',
  'warning',
  'storage',
  'fda_disclaimer',
  'product_attributes',
  'ingredient_highlights',
  'approved_claims',
];

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!(trimmed.startsWith('[') || trimmed.startsWith('{'))) return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function normalizeApprovedClaims(value) {
  if (!value) return [];
  const parsed = parseMaybeJson(value);
  const items = Array.isArray(parsed) ? parsed : [parsed];

  return items
    .map((item) => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? { text, source: 'manual_approval' } : null;
      }
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        const text = item.text.trim();
        if (!text) return null;
        return {
          text,
          source: item.source || 'manual_approval',
          note: item.note || null,
        };
      }
      return null;
    })
    .filter(Boolean);
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === null || item === undefined) return false;
      if (typeof item === 'string' && !item.trim()) return false;
      if (Array.isArray(item) && item.length === 0) return false;
      return true;
    })
  );
}

export function buildApprovedSource(product) {
  const metafields = new Map(
    (product?.metafields?.nodes || []).map((node) => [node.key, node.value])
  );

  const rawSources = {};
  for (const key of RAW_SOURCE_KEYS) {
    const value = metafields.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      rawSources[key] = parseMaybeJson(value);
    }
  }

  // Runtime fallback so content generation still has serving facts even if a
  // backfill has not persisted the derived serving metafields yet.
  if (!rawSources.serving_size || !rawSources.servings_per_container) {
    const derived = deriveServingInfo({
      suggested_use: rawSources.suggested_use,
      product_amount: rawSources.product_amount,
    });

    if (!rawSources.serving_size && derived.serving_size) {
      rawSources.serving_size = derived.serving_size;
    }
    if (!rawSources.servings_per_container && derived.servings_per_container) {
      rawSources.servings_per_container = derived.servings_per_container;
    }
    if (!rawSources.serving_derivation && (derived.serving_size || derived.servings_per_container)) {
      rawSources.serving_derivation = derived.derivation;
    }
  }

  const approvedClaims = normalizeApprovedClaims(rawSources.approved_claims);

  const facts = compactObject({
    ingredients: rawSources.ingredients,
    ingredient_highlights: rawSources.ingredient_highlights,
    other_ingredients: rawSources.other_ingredients,
    contains: rawSources.contains,
    manufacturer_country: rawSources.manufacturer_country,
    product_amount: rawSources.product_amount,
    gross_weight: rawSources.gross_weight,
    serving_size: rawSources.serving_size,
    servings_per_container: rawSources.servings_per_container,
    serving_derivation: rawSources.serving_derivation,
    suggested_use: rawSources.suggested_use,
    caution: rawSources.caution,
    iron_warning: rawSources.iron_warning,
    warning: rawSources.warning,
    storage: rawSources.storage,
    product_attributes: rawSources.product_attributes,
  });

  // Source-backed structure/function and general-wellness claims may come from
  // the manufacturer/Supliful marketing description. Claude may only reuse an
  // exact contiguous quote from this text; it may not strengthen or invent it.
  const sourceClaimText = typeof rawSources.description_clean === 'string'
    ? rawSources.description_clean.trim()
    : '';

  return {
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
    },
    facts,
    source_claim_text: sourceClaimText || null,
    approved_claims: approvedClaims,
    raw_sources: rawSources,
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sourceFingerprint(approvedSource) {
  const canonical = stableStringify({
    facts: approvedSource.facts,
    source_claim_text: approvedSource.source_claim_text,
    approved_claims: approvedSource.approved_claims,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
