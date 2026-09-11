const HIGH_RISK_PATTERNS = [
  /\bdiagnos(?:e|es|ed|ing|is)\b/i,
  /\btreat(?:s|ed|ing|ment)?\b/i,
  /\bcure(?:s|d|ing)?\b/i,
  /\bprevent(?:s|ed|ing|ion)?\b/i,
  /\breverse(?:s|d|ing)?\b/i,
  /\bheal(?:s|ed|ing)?\b/i,
  /\bdisease\b/i,
  /\bcancer\b/i,
  /\bdiabetes\b/i,
  /\bfatty liver\b/i,
  /\bhigh blood pressure\b/i,
];

function normalize(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .trim()
    .toLowerCase();
}

function flattenSource(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(flattenSource).join(' | ');
  if (typeof value === 'object') return Object.values(value).map(flattenSource).join(' | ');
  return '';
}

function claimEntries(content) {
  const entries = [];

  const pushClaim = (location, value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.text !== 'string' || !value.text.trim()) return;
    entries.push({ location, ...value });
  };

  pushClaim('product_summary', content?.product_summary);
  pushClaim('ingredient_story.what_it_is', content?.ingredient_story?.what_it_is);
  pushClaim('ingredient_story.why_in_formula', content?.ingredient_story?.why_in_formula);

  (content?.formula_highlights || []).forEach((item, index) => {
    pushClaim(`formula_highlights[${index}]`, item);
  });

  return entries;
}

export function validateGeneratedContent(content, approvedSource) {
  const issues = [];
  const sources = approvedSource?.sources || {};

  for (const claim of claimEntries(content)) {
    const text = String(claim.text || '').trim();
    const sourceField = String(claim.source_field || '').trim();
    const sourceQuote = String(claim.source_quote || '').trim();

    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(text)) {
        issues.push({
          code: 'HIGH_RISK_LANGUAGE',
          location: claim.location,
          text,
        });
        break;
      }
    }

    if (!sourceField || !(sourceField in sources)) {
      issues.push({
        code: 'MISSING_OR_INVALID_SOURCE_FIELD',
        location: claim.location,
        source_field: sourceField || null,
      });
      continue;
    }

    if (!sourceQuote) {
      issues.push({
        code: 'MISSING_SOURCE_QUOTE',
        location: claim.location,
      });
      continue;
    }

    const sourceText = normalize(flattenSource(sources[sourceField]));
    const quoteText = normalize(sourceQuote);

    if (!sourceText.includes(quoteText)) {
      issues.push({
        code: 'SOURCE_QUOTE_NOT_FOUND',
        location: claim.location,
        source_field: sourceField,
        source_quote: sourceQuote,
      });
    }
  }

  // Usage fields must be exact copies of approved source values.
  const usage = content?.usage_display || null;
  if (usage) {
    const exactPairs = [
      ['serving_size', 'serving_size'],
      ['servings_per_container', 'servings_per_container'],
      ['suggested_use', 'suggested_use'],
    ];

    for (const [outputKey, sourceKey] of exactPairs) {
      const outputValue = usage[outputKey];
      if (outputValue === null || outputValue === undefined || outputValue === '') continue;
      const sourceValue = sources[sourceKey];
      if (normalize(outputValue) !== normalize(sourceValue)) {
        issues.push({
          code: 'USAGE_NOT_EXACT_SOURCE_COPY',
          location: `usage_display.${outputKey}`,
          source_field: sourceKey,
        });
      }
    }
  }

  return {
    passed: issues.length === 0,
    requires_review: issues.length > 0,
    issues,
  };
}
