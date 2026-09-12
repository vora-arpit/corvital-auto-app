const HARD_BLOCK_PATTERNS = [
  /\bdiagnos(?:e|es|ed|ing|is)\b/i,
  /\btreat(?:s|ed|ing|ment)?\b/i,
  /\bcure(?:s|d|ing)?\b/i,
  /\bprevent(?:s|ed|ing|ion)?\b/i,
  /\bmitigat(?:e|es|ed|ing|ion)\b/i,
  /\breverse(?:s|d|ing)?\b/i,
  /\bheal(?:s|ed|ing)?\b/i,
  /\bdisease\b/i,
  /\bcancer\b/i,
  /\bdiabetes\b/i,
  /\bfatty liver\b/i,
  /\bhigh blood pressure\b/i,
  /\bhypertension\b/i,
];

const VALID_CLAIM_TYPES = new Set([
  'fact',
  'approved_claim',
  'unapproved_claim',
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

function addIssue(target, issue) {
  target.push(issue);
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

function validateIngredientFacts(content, approvedSource, hardIssues) {
  const sourceText = normalize(flatten([
    approvedSource?.facts?.ingredients,
    approvedSource?.facts?.ingredient_highlights,
  ]));

  if (!sourceText) return;

  const stories = Array.isArray(content?.ingredient_story)
    ? content.ingredient_story
    : [];

  stories.forEach((story, index) => {
    const name = String(story?.name || '').trim();
    const amount = String(story?.amount || '').trim();

    if (name && !sourceText.includes(normalize(name))) {
      addIssue(hardIssues, {
        code: 'INGREDIENT_NAME_NOT_FOUND_IN_FACTS',
        location: `ingredient_story[${index}].name`,
        value: name,
      });
    }

    if (amount && !sourceText.includes(normalize(amount))) {
      addIssue(hardIssues, {
        code: 'INGREDIENT_AMOUNT_NOT_FOUND_IN_FACTS',
        location: `ingredient_story[${index}].amount`,
        value: amount,
      });
    }
  });
}

export function validateGeneratedContent(content, approvedSource) {
  const hardIssues = [];
  const reviewIssues = [];
  const facts = approvedSource?.facts || {};
  const approvedClaims = approvedClaimsText(approvedSource);

  for (const claim of claimEntries(content)) {
    const text = String(claim.text || '').trim();
    const claimType = String(claim.claim_type || '').trim();
    const sourceType = String(claim.source_type || '').trim();
    const sourceField = String(claim.source_field || '').trim();
    const sourceQuote = String(claim.source_quote || '').trim();

    if (!VALID_CLAIM_TYPES.has(claimType)) {
      addIssue(hardIssues, {
        code: 'INVALID_CLAIM_TYPE',
        location: claim.location,
        claim_type: claimType || null,
      });
      continue;
    }

    if (claimType === 'disease_claim' || HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(text))) {
      addIssue(hardIssues, {
        code: 'DISEASE_OR_HIGH_RISK_CLAIM',
        location: claim.location,
        text,
      });
      continue;
    }

    if (claimType === 'unapproved_claim') {
      addIssue(hardIssues, {
        code: 'UNAPPROVED_CLAIM_GENERATED',
        location: claim.location,
        text,
      });
      continue;
    }

    if (!sourceQuote) {
      addIssue(hardIssues, {
        code: 'MISSING_SOURCE_QUOTE',
        location: claim.location,
      });
      continue;
    }

    if (claimType === 'fact') {
      if (sourceType !== 'fact' || !(sourceField in facts)) {
        addIssue(hardIssues, {
          code: 'INVALID_FACT_SOURCE',
          location: claim.location,
          source_type: sourceType || null,
          source_field: sourceField || null,
        });
        continue;
      }

      const sourceText = normalize(flatten(facts[sourceField]));
      if (!sourceText.includes(normalize(sourceQuote))) {
        addIssue(hardIssues, {
          code: 'FACT_SOURCE_QUOTE_NOT_FOUND',
          location: claim.location,
          source_field: sourceField,
          source_quote: sourceQuote,
        });
      }
    }

    if (claimType === 'approved_claim') {
      if (sourceType !== 'approved_claim' || sourceField !== 'approved_claims') {
        addIssue(hardIssues, {
          code: 'INVALID_APPROVED_CLAIM_SOURCE',
          location: claim.location,
        });
        continue;
      }

      if (!normalize(approvedClaims).includes(normalize(sourceQuote))) {
        addIssue(hardIssues, {
          code: 'APPROVED_CLAIM_NOT_FOUND',
          location: claim.location,
          source_quote: sourceQuote,
        });
      }
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
        addIssue(hardIssues, {
          code: 'USAGE_FACT_MISSING',
          location: `usage_display.${key}`,
        });
        continue;
      }

      if (normalize(outputValue) !== normalize(sourceValue)) {
        addIssue(hardIssues, {
          code: 'USAGE_NOT_EXACT_FACT_COPY',
          location: `usage_display.${key}`,
        });
      }
    }
  }

  // Claude's compliance notes are advisory only. They do not override the
  // deterministic validator. Keep them visible as review notes if present.
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

export function stripReviewClaims(content, validation) {
  // Under the Stage 4D model, an output either validates against FACTS /
  // APPROVED_CLAIMS or it is a hard validation failure. No health claim is
  // silently accepted merely because it came from raw marketing copy.
  if (!validation?.safe_to_write_publishable_preview) return null;
  return JSON.parse(JSON.stringify(content || {}));
}
