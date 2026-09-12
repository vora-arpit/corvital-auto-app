const HARD_BLOCK_PATTERNS = [
  /\bdiagnos(?:e|es|ed|ing|is)\b/i,
  /\btreat(?:s|ed|ing|ment)?\b/i,
  /\bcure(?:s|d|ing)?\b/i,
  /\bprevent(?:s|ed|ing|ion)?\b/i,
  /\bmitigat(?:e|es|ed|ing|ion)\b/i,
  /\breverse(?:s|d|ing)?\b/i,
  /\bdisease\b/i,
  /\bcancer\b/i,
  /\bdiabetes\b/i,
  /\bfatty liver\b/i,
  /\bhigh blood pressure\b/i,
  /\bhypertension\b/i,
];

const VALID_CLAIM_TYPES = new Set([
  'fact',
  'source_claim',
  'approved_claim',
  'disease_claim',
]);

function normalize(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .trim()
    .toLowerCase();
}

function flatten(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(flatten).join(' | ');
  if (typeof value === 'object') return Object.values(value).map(flatten).join(' | ');
  return '';
}

function claimEntries(content) {
  const entries = [];
  const push = (location, value) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.text !== 'string' || !value.text.trim()) return;
    entries.push({ location, ...value });
  };

  push('product_summary', content?.product_summary);

  const stories = Array.isArray(content?.ingredient_story)
    ? content.ingredient_story
    : content?.ingredient_story
      ? [content.ingredient_story]
      : [];

  stories.forEach((story, index) => {
    push(`ingredient_story[${index}].what_it_is`, story?.what_it_is);
    push(`ingredient_story[${index}].why_in_formula`, story?.why_in_formula);
  });

  (content?.formula_highlights || []).forEach((item, index) => {
    push(`formula_highlights[${index}]`, item);
  });

  return entries;
}

function approvedClaimsText(approvedSource) {
  return (approvedSource?.approved_claims || [])
    .map((item) => (typeof item === 'string' ? item : item?.text))
    .filter(Boolean)
    .join(' | ');
}

function structuredIngredientText(approvedSource) {
  return normalize(flatten([
    approvedSource?.facts?.ingredients,
    approvedSource?.facts?.ingredient_highlights,
  ]));
}

function allAuthoritativeSourceText(approvedSource) {
  return normalize(flatten([
    approvedSource?.facts,
    approvedSource?.raw_sources,
  ]));
}

function validateIngredientFacts(content, approvedSource, hardIssues) {
  const sourceText = structuredIngredientText(approvedSource);
  if (!sourceText) return;

  const stories = Array.isArray(content?.ingredient_story)
    ? content.ingredient_story
    : [];

  // Only ingredient_story rows represent actual ingredient identities.
  // formula_highlights titles are presentation labels and are intentionally
  // allowed to be benefit/category headings such as "Sleep Support".
  const rows = stories.map((story, index) => ({
    location: `ingredient_story[${index}]`,
    name: story?.name,
    amount: story?.amount,
  }));

  const broadSourceText = allAuthoritativeSourceText(approvedSource);

  for (const row of rows) {
    const name = String(row.name || '').trim();
    const amount = String(row.amount || '').trim();

    if (name && !sourceText.includes(normalize(name))) {
      hardIssues.push({
        code: 'INGREDIENT_NAME_NOT_FOUND_IN_FACTS',
        location: `${row.location}.name`,
        value: name,
      });
    }

    // Amounts can sometimes be present in the authoritative raw supplement
    // source even when the parsed ingredient_highlights omitted them.
    if (amount && !sourceText.includes(normalize(amount)) && !broadSourceText.includes(normalize(amount))) {
      hardIssues.push({
        code: 'INGREDIENT_AMOUNT_NOT_FOUND_IN_SOURCE',
        location: `${row.location}.amount`,
        value: amount,
      });
    }
  }
}

function sourceClaimIsExactQuote(claim, approvedSource) {
  const quote = normalize(claim.source_quote);
  if (!quote) return false;

  if (claim.claim_type === 'source_claim') {
    return normalize(approvedSource?.source_claim_text).includes(quote);
  }

  if (claim.claim_type === 'approved_claim') {
    return normalize(approvedClaimsText(approvedSource)).includes(quote);
  }

  return false;
}

export function validateGeneratedContent(content, approvedSource) {
  const hardIssues = [];
  const reviewIssues = [];
  const facts = approvedSource?.facts || {};

  for (const claim of claimEntries(content)) {
    const text = String(claim.text || '').trim();
    const claimType = String(claim.claim_type || '').trim();
    const sourceType = String(claim.source_type || '').trim();
    const sourceField = String(claim.source_field || '').trim();
    const sourceQuote = String(claim.source_quote || '').trim();

    if (!VALID_CLAIM_TYPES.has(claimType)) {
      hardIssues.push({
        code: 'INVALID_CLAIM_TYPE',
        location: claim.location,
        claim_type: claimType || null,
      });
      continue;
    }

    if (claimType === 'disease_claim' || HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) {
      hardIssues.push({
        code: 'DISEASE_OR_HIGH_RISK_CLAIM',
        location: claim.location,
        text,
      });
      continue;
    }

    if (!sourceQuote) {
      hardIssues.push({
        code: 'MISSING_SOURCE_QUOTE',
        location: claim.location,
      });
      continue;
    }

    if (claimType === 'fact') {
      if (sourceType !== 'fact' || !(sourceField in facts)) {
        hardIssues.push({
          code: 'INVALID_FACT_SOURCE',
          location: claim.location,
          source_type: sourceType,
          source_field: sourceField,
        });
        continue;
      }

      // For structured ingredient arrays, exact combined quote matching is not
      // required because name and amount can be separate JSON fields. Those are
      // validated independently below. For ordinary scalar/text facts, require
      // the quote to exist in that exact fact field.
      if (!['ingredient_highlights', 'ingredients'].includes(sourceField)) {
        const factText = normalize(flatten(facts[sourceField]));
        if (!factText.includes(normalize(sourceQuote))) {
          hardIssues.push({
            code: 'FACT_SOURCE_QUOTE_NOT_FOUND',
            location: claim.location,
            source_field: sourceField,
            source_quote: sourceQuote,
          });
        }
      }
      continue;
    }

    if (claimType === 'source_claim') {
      if (sourceType !== 'source_claim' || sourceField !== 'description_clean') {
        hardIssues.push({
          code: 'INVALID_SOURCE_CLAIM_REFERENCE',
          location: claim.location,
        });
        continue;
      }

      if (!sourceClaimIsExactQuote(claim, approvedSource)) {
        hardIssues.push({
          code: 'SOURCE_CLAIM_QUOTE_NOT_FOUND',
          location: claim.location,
          source_quote: sourceQuote,
        });
        continue;
      }

      // Minor shortening/grammar cleanup by the model is allowed here.
      // We do not publish the rewritten wording: buildPublishableContent()
      // deterministically replaces it with the exact verified source_quote.
      continue;
    }

    if (claimType === 'approved_claim') {
      if (sourceType !== 'approved_claim' || sourceField !== 'approved_claims') {
        hardIssues.push({
          code: 'INVALID_APPROVED_CLAIM_REFERENCE',
          location: claim.location,
        });
        continue;
      }

      if (!sourceClaimIsExactQuote(claim, approvedSource)) {
        hardIssues.push({
          code: 'APPROVED_CLAIM_QUOTE_NOT_FOUND',
          location: claim.location,
          source_quote: sourceQuote,
        });
        continue;
      }

      // As with source claims, publish the exact approved source wording
      // rather than any model paraphrase.
    }
  }

  validateIngredientFacts(content, approvedSource, hardIssues);

  const usage = content?.usage_display || null;
  if (usage) {
    for (const key of ['serving_size', 'servings_per_container', 'suggested_use']) {
      const outputValue = usage[key];
      if (outputValue === null || outputValue === undefined || outputValue === '') continue;

      const sourceValue = facts[key];
      if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
        hardIssues.push({
          code: 'USAGE_FACT_MISSING',
          location: `usage_display.${key}`,
        });
        continue;
      }

      if (normalize(outputValue) !== normalize(sourceValue)) {
        hardIssues.push({
          code: 'USAGE_NOT_EXACT_FACT_COPY',
          location: `usage_display.${key}`,
        });
      }
    }
  }

  for (const issue of content?.compliance?.issues || []) {
    if (String(issue || '').trim()) {
      reviewIssues.push({ code: 'MODEL_REVIEW_NOTE', text: String(issue).trim() });
    }
  }

  const hardPass = hardIssues.length === 0;

  return {
    passed: hardPass,
    safe_to_write_publishable_preview: hardPass,
    requires_review: reviewIssues.length > 0 || hardIssues.length > 0,
    hard_issues: hardIssues,
    review_issues: reviewIssues,
    issues: [...hardIssues, ...reviewIssues],
  };
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

function decorateTextObject(value) {
  if (!value || typeof value !== 'object') return value;
  const copy = { ...value };
  if (copy.claim_type === 'source_claim' || copy.claim_type === 'approved_claim') {
    // Always publish the exact validated source wording, never Claude's
    // shortened/paraphrased variant. This keeps claims source-grounded while
    // still allowing Claude to choose and organize them for presentation.
    const exactSourceText = String(copy.source_quote || '').trim();
    copy.text = appendClaimAsterisk(exactSourceText || copy.text);
  }
  return copy;
}

export function buildPublishableContent(content, validation) {
  if (!validation?.safe_to_write_publishable_preview) return null;

  const output = JSON.parse(JSON.stringify(content || {}));

  if (output.product_summary) {
    output.product_summary = decorateTextObject(output.product_summary);
  }

  if (Array.isArray(output.ingredient_story)) {
    output.ingredient_story = output.ingredient_story.map((story) => ({
      ...story,
      what_it_is: decorateTextObject(story?.what_it_is),
      why_in_formula: decorateTextObject(story?.why_in_formula),
    }));
  }

  if (Array.isArray(output.formula_highlights)) {
    output.formula_highlights = output.formula_highlights.map(decorateTextObject);
  }

  return output;
}
