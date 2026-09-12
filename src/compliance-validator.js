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

const REVIEW_CLAIM_PATTERNS = [
  /\bsupport(?:s|ed|ing)?\b/i,
  /\bmaintain(?:s|ed|ing)?\b/i,
  /\bpromot(?:e|es|ed|ing)\b/i,
  /\bhelp(?:s|ed|ing)?\b/i,
  /\bfunction\b/i,
  /\bresponse\b/i,
  /\bwellness\b/i,
  /\bwell[- ]?being\b/i,
  /\bvitality\b/i,
  /\benergy\b/i,
  /\bmetabolic\b/i,
  /\bmetabolism\b/i,
  /\bcognitive\b/i,
  /\bcardiovascular\b/i,
  /\bimmune\b/i,
  /\brepair\b/i,
  /\bantioxidant\b/i,
  /\binflammat(?:ion|ory)\b/i,
  /\bdigest(?:ion|ive)\b/i,
  /\bsleep\b/i,
  /\bstress\b/i,
  /\bmood\b/i,
  /\bperformance\b/i,
  /\bhealth\b/i,
];

const VALID_CLAIM_TYPES = new Set([
  'objective_fact',
  'ingredient_identity',
  'structure_function_claim',
  'general_wellbeing_claim',
  'disease_claim',
  'other_claim',
  // Backward compatibility for one deployment cycle.
  'fact',
]);

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

  const stories = Array.isArray(content?.ingredient_story)
    ? content.ingredient_story
    : content?.ingredient_story
      ? [content.ingredient_story]
      : [];

  stories.forEach((story, index) => {
    pushClaim(`ingredient_story[${index}].what_it_is`, story?.what_it_is);
    pushClaim(`ingredient_story[${index}].why_in_formula`, story?.why_in_formula);
  });

  (content?.formula_highlights || []).forEach((item, index) => {
    pushClaim(`formula_highlights[${index}]`, item);
  });

  return entries;
}

function addIssue(target, issue) {
  target.push(issue);
}

function containsAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function validateIngredientFacts(content, approvedSource, hardIssues) {
  const sourceText = normalize(flattenSource(approvedSource?.sources?.ingredients));
  if (!sourceText) return;

  const stories = Array.isArray(content?.ingredient_story)
    ? content.ingredient_story
    : content?.ingredient_story
      ? [content.ingredient_story]
      : [];

  stories.forEach((story, index) => {
    const name = String(story?.name || '').trim();
    const amount = String(story?.amount || '').trim();

    if (name && !sourceText.includes(normalize(name))) {
      addIssue(hardIssues, {
        code: 'INGREDIENT_NAME_NOT_FOUND_IN_SOURCE',
        location: `ingredient_story[${index}].name`,
        value: name,
      });
    }

    if (amount && !sourceText.includes(normalize(amount))) {
      addIssue(hardIssues, {
        code: 'INGREDIENT_AMOUNT_NOT_FOUND_IN_SOURCE',
        location: `ingredient_story[${index}].amount`,
        value: amount,
      });
    }
  });
}

function normalizeClaimType(value) {
  // Old preview output used "fact". Treat it as objective_fact only when the
  // text itself does not contain health/physiology signals.
  if (value === 'fact') return 'objective_fact';
  return value;
}

export function validateGeneratedContent(content, approvedSource) {
  const hardIssues = [];
  const reviewIssues = [];
  const sources = approvedSource?.sources || {};

  for (const claim of claimEntries(content)) {
    const text = String(claim.text || '').trim();
    const sourceField = String(claim.source_field || '').trim();
    const sourceQuote = String(claim.source_quote || '').trim();
    const rawClaimType = String(claim.claim_type || '').trim();
    const claimType = normalizeClaimType(rawClaimType);

    if (!VALID_CLAIM_TYPES.has(rawClaimType)) {
      addIssue(hardIssues, {
        code: 'MISSING_OR_INVALID_CLAIM_TYPE',
        location: claim.location,
        claim_type: rawClaimType || null,
      });
    }

    if (!sourceField || !(sourceField in sources)) {
      addIssue(hardIssues, {
        code: 'MISSING_OR_INVALID_SOURCE_FIELD',
        location: claim.location,
        source_field: sourceField || null,
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

    const sourceText = normalize(flattenSource(sources[sourceField]));
    const quoteText = normalize(sourceQuote);

    if (!sourceText.includes(quoteText)) {
      addIssue(hardIssues, {
        code: 'SOURCE_QUOTE_NOT_FOUND',
        location: claim.location,
        source_field: sourceField,
        source_quote: sourceQuote,
      });
    }

    if (containsAny(text, HARD_BLOCK_PATTERNS) || claimType === 'disease_claim') {
      addIssue(hardIssues, {
        code: 'DISEASE_OR_HIGH_RISK_CLAIM',
        location: claim.location,
        text,
        claim_type: claimType || null,
      });
      continue;
    }

    const looksLikeHealthClaim = containsAny(text, REVIEW_CLAIM_PATTERNS);
    const isObjectiveType =
      claimType === 'objective_fact' || claimType === 'ingredient_identity';

    // Objective facts/identity can auto-pass only when the actual text does
    // not contain health, physiology, performance, outcome, or wellbeing wording.
    if (!isObjectiveType || looksLikeHealthClaim) {
      addIssue(reviewIssues, {
        code: 'CLAIM_REQUIRES_REVIEW',
        location: claim.location,
        text,
        claim_type: claimType || (looksLikeHealthClaim ? 'unclassified_health_claim' : null),
        source_field: sourceField,
      });
    }
  }

  validateIngredientFacts(content, approvedSource, hardIssues);

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
      if (sourceValue === null || sourceValue === undefined || sourceValue === '') {
        addIssue(hardIssues, {
          code: 'USAGE_SOURCE_MISSING',
          location: `usage_display.${outputKey}`,
          source_field: sourceKey,
        });
        continue;
      }

      if (normalize(outputValue) !== normalize(sourceValue)) {
        addIssue(hardIssues, {
          code: 'USAGE_NOT_EXACT_SOURCE_COPY',
          location: `usage_display.${outputKey}`,
          source_field: sourceKey,
        });
      }
    }
  }

  const hardPass = hardIssues.length === 0;

  return {
    passed: hardPass,
    // Clear name: this means only the FILTERED publishable preview is safe
    // to persist. It does not mean every generated claim was approved.
    safe_to_write_publishable_preview: hardPass,
    // Deprecated compatibility alias for the existing Stage 4B caller.
    safe_to_write: hardPass,
    requires_review: reviewIssues.length > 0 || hardIssues.length > 0,
    hard_issues: hardIssues,
    review_issues: reviewIssues,
    issues: [...hardIssues, ...reviewIssues],
  };
}

export function stripReviewClaims(content, validation) {
  const reviewLocations = new Set(
    (validation?.review_issues || []).map((issue) => issue.location)
  );

  const result = JSON.parse(JSON.stringify(content || {}));

  if (reviewLocations.has('product_summary')) {
    result.product_summary = null;
  }

  const stories = Array.isArray(result.ingredient_story)
    ? result.ingredient_story
    : result.ingredient_story
      ? [result.ingredient_story]
      : [];

  stories.forEach((story, index) => {
    if (reviewLocations.has(`ingredient_story[${index}].what_it_is`)) {
      story.what_it_is = null;
    }
    if (reviewLocations.has(`ingredient_story[${index}].why_in_formula`)) {
      story.why_in_formula = null;
    }
  });
  result.ingredient_story = stories;

  result.formula_highlights = (result.formula_highlights || []).filter(
    (_item, index) => !reviewLocations.has(`formula_highlights[${index}]`)
  );

  return result;
}
