const DOSAGE_FORMS = {
  capsule: ['capsule', 'capsules'],
  tablet: ['tablet', 'tablets'],
  softgel: ['softgel', 'softgels', 'soft gel', 'soft gels'],
  gummy: ['gummy', 'gummies'],
  scoop: ['scoop', 'scoops'],
  packet: ['packet', 'packets'],
};

function normalizeForm(value) {
  const text = String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [canonical, forms] of Object.entries(DOSAGE_FORMS)) {
    if (forms.includes(text)) return canonical;
  }
  return null;
}

function displayForm(canonical, count) {
  if (!canonical) return null;
  const singular = canonical === 'softgel' ? 'softgel' : canonical;
  return count === 1 ? singular : `${singular}s`;
}

function hasAmbiguousFrequency(text) {
  return /\b(?:twice|three times|four times|\d+\s+times)\s+(?:a\s+)?day\b/i.test(text)
    || /\b(?:morning\s+and\s+(?:evening|night)|every\s+\d+\s+hours?)\b/i.test(text)
    || /\b\d+\s*(?:-|to)\s*\d+\s+(?:capsules?|tablets?|soft\s*gels?|gummies|scoops?|packets?)\b/i.test(text)
    || /\bone\s*(?:-|to)\s*two\s+(?:capsules?|tablets?|soft\s*gels?|gummies|scoops?|packets?)\b/i.test(text);
}

function extractDoseFromSuggestedUse(suggestedUse) {
  const text = String(suggestedUse || '').replace(/\s+/g, ' ').trim();
  if (!text || hasAmbiguousFrequency(text)) return null;

  const patterns = [
    /\btake\s+[a-z-]+\s*\((\d+)\)\s+(capsules?|tablets?|soft\s*gels?|gummies|scoops?|packets?)\b/i,
    /\btake\s+\(?([1-9]\d*)\)?\s+(capsules?|tablets?|soft\s*gels?|gummies|scoops?|packets?)\b/i,
    /\bserving\s+size\s*(?:is|:)?\s*\(?([1-9]\d*)\)?\s+(capsules?|tablets?|soft\s*gels?|gummies|scoops?|packets?)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const count = Number(match[1]);
    const form = normalizeForm(match[2]);
    if (!Number.isInteger(count) || count <= 0 || !form) return null;

    return { count, form };
  }

  return null;
}

function extractContainerCount(productAmount) {
  const text = String(productAmount || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const match = text.match(/\b([1-9]\d*)\s+(capsules?|tablets?|soft\s*gels?|gummies|scoops?|packets?)\b/i);
  if (!match) return null;

  const count = Number(match[1]);
  const form = normalizeForm(match[2]);
  if (!Number.isInteger(count) || count <= 0 || !form) return null;

  return { count, form };
}

/**
 * Deterministically derives serving information from two authoritative fields.
 * It never uses ingredient amounts, never guesses from weight, and refuses
 * ambiguous multi-dose or range instructions.
 */
export function deriveServingInfo({ suggested_use, product_amount } = {}) {
  const dose = extractDoseFromSuggestedUse(suggested_use);
  const container = extractContainerCount(product_amount);

  const result = {
    serving_size: null,
    servings_per_container: null,
    derivation: {
      serving_size: null,
      servings_per_container: null,
    },
  };

  if (!dose) return result;

  result.serving_size = `${dose.count} ${displayForm(dose.form, dose.count)}`;
  result.derivation.serving_size = {
    method: 'derived_from_suggested_use',
    source_field: 'suggested_use',
    source_value: String(suggested_use || '').trim(),
  };

  if (!container || container.form !== dose.form) return result;
  if (container.count % dose.count !== 0) return result;

  const servings = container.count / dose.count;
  if (!Number.isInteger(servings) || servings <= 0) return result;

  result.servings_per_container = String(servings);
  result.derivation.servings_per_container = {
    method: 'calculated_from_product_amount_and_serving_size',
    source_fields: ['product_amount', 'suggested_use'],
    calculation: `${container.count} / ${dose.count} = ${servings}`,
    product_amount: String(product_amount || '').trim(),
    serving_size: result.serving_size,
  };

  return result;
}
