import crypto from 'node:crypto';

const SOURCE_KEYS = [
  'description_clean',
  'ingredients',
  'other_ingredients',
  'contains',
  'manufacturer_country',
  'product_amount',
  'gross_weight',
  'serving_size',
  'servings_per_container',
  'suggested_use',
  'caution',
  'iron_warning',
  'warning',
  'storage',
  'fda_disclaimer',
  'product_attributes',
  'ingredient_highlights',
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

export function buildApprovedSource(product) {
  const metafields = new Map(
    (product?.metafields?.nodes || []).map((node) => [node.key, node.value])
  );

  const sources = {};
  for (const key of SOURCE_KEYS) {
    const value = metafields.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      sources[key] = parseMaybeJson(value);
    }
  }

  return {
    product: {
      id: product.id,
      title: product.title,
      handle: product.handle,
    },
    sources,
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function sourceFingerprint(approvedSource) {
  const canonical = stableStringify(approvedSource.sources);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}
