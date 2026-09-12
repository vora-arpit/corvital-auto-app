import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

function getClient() {
  if (!config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is missing.');
  }
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

const SYSTEM_PROMPT = `
You create structured ecommerce presentation content for a U.S. dietary supplement product.

You receive four buckets:
1. FACTS — authoritative product/composition/usage facts.
2. SOURCE_CLAIM_TEXT — manufacturer/Supliful product-description text that may contain structure/function or general-wellness claims.
3. APPROVED_CLAIMS — optional merchant-approved claims. These are additional allowed claim sources; they are NOT required when an acceptable claim already appears in SOURCE_CLAIM_TEXT.
4. RAW_SOURCES — audit context only.

STRICT GROUNDING RULES
1. Never use outside knowledge, web knowledge, common ingredient knowledge, or assumptions.
2. FACT statements may only come from FACTS.
3. A structure/function or general-wellness claim may be used when it is an EXACT contiguous quote from SOURCE_CLAIM_TEXT or an EXACT approved claim from APPROVED_CLAIMS.
4. Do not strengthen, broaden, combine, summarize, or creatively rewrite a health/wellness claim. Use the source wording itself.
5. Never generate a disease claim, diagnosis/treatment/cure/prevention/mitigation claim, or wording that names a disease as an outcome.
6. Ingredient identity may restate factual identity from FACTS (name, chemical expansion, plant source, plant part, standardization, amount), but do not add physiology unless it is used as a source-backed claim under rule 3.
7. Ingredient names and amounts must match FACTS exactly.
8. serving_size, servings_per_container, and suggested_use must be copied exactly from FACTS when present.
9. Never invent timelines, studies, percentages, certifications, dosage, safety claims, or results.
10. If a requested field is unsupported, return null or [].
11. Do NOT add an asterisk to any claim. The application adds the asterisk deterministically after validation.
12. Use the emit_product_content tool exactly once with the final structured result. Do not answer with prose.

CLAIM TYPES
Use exactly one:
- "fact" — factual identity/composition/usage information from FACTS.
- "source_claim" — an exact structure/function or general-wellness claim from SOURCE_CLAIM_TEXT.
- "approved_claim" — an exact claim from APPROVED_CLAIMS.
- "disease_claim" — prohibited disease wording. Never generate it.

SOURCE RULES
Every text object must contain:
- source_type: "fact", "source_claim", or "approved_claim"
- source_field: for facts, the exact FACTS key; for source claims, "description_clean"; for approved claims, "approved_claims"
- source_quote: an exact contiguous quote from the applicable source.

PREFERENCE
Use useful source-backed "supports", "helps maintain", "promotes", and similar structure/function/general-wellness wording when it is present in SOURCE_CLAIM_TEXT. Do not omit such claims merely because APPROVED_CLAIMS is empty.
`.trim();

const textObjectSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string' },
    claim_type: {
      type: 'string',
      enum: ['fact', 'source_claim', 'approved_claim', 'disease_claim'],
    },
    source_type: {
      type: 'string',
      enum: ['fact', 'source_claim', 'approved_claim'],
    },
    source_field: { type: 'string' },
    source_quote: { type: 'string' },
  },
  required: ['text', 'claim_type', 'source_type', 'source_field', 'source_quote'],
};

const nullableTextObjectSchema = {
  anyOf: [textObjectSchema, { type: 'null' }],
};

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    product_summary: nullableTextObjectSchema,
    ingredient_story: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          amount: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          what_it_is: nullableTextObjectSchema,
          why_in_formula: nullableTextObjectSchema,
        },
        required: ['name', 'amount', 'what_it_is', 'why_in_formula'],
      },
    },
    formula_highlights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          amount: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          text: { type: 'string' },
          claim_type: {
            type: 'string',
            enum: ['fact', 'source_claim', 'approved_claim', 'disease_claim'],
          },
          source_type: {
            type: 'string',
            enum: ['fact', 'source_claim', 'approved_claim'],
          },
          source_field: { type: 'string' },
          source_quote: { type: 'string' },
        },
        required: [
          'title',
          'amount',
          'text',
          'claim_type',
          'source_type',
          'source_field',
          'source_quote',
        ],
      },
    },
    usage_display: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            serving_size: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            servings_per_container: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            suggested_use: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          },
          required: ['serving_size', 'servings_per_container', 'suggested_use'],
        },
        { type: 'null' },
      ],
    },
    compliance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        requires_review: { type: 'boolean' },
        issues: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['requires_review', 'issues'],
    },
  },
  required: [
    'product_summary',
    'ingredient_story',
    'formula_highlights',
    'usage_display',
    'compliance',
  ],
};

const CONTENT_TOOL = {
  name: 'emit_product_content',
  description: 'Return the final source-grounded product content in the required schema.',
  input_schema: OUTPUT_SCHEMA,
};

function extractToolInput(message) {
  const toolBlock = (message?.content || []).find(
    (block) => block.type === 'tool_use' && block.name === CONTENT_TOOL.name
  );

  if (!toolBlock || !toolBlock.input || typeof toolBlock.input !== 'object') {
    throw new Error('Claude did not return the required structured product-content tool output.');
  }

  return toolBlock.input;
}

async function requestStructuredContent(client, modelInput) {
  return client.messages.create({
    model: config.claudeModel,
    max_tokens: 3200,
    temperature: 0,
    system: SYSTEM_PROMPT,
    tools: [CONTENT_TOOL],
    tool_choice: { type: 'tool', name: CONTENT_TOOL.name },
    messages: [
      {
        role: 'user',
        content: `PRODUCT_SOURCE:\n${JSON.stringify(modelInput, null, 2)}`,
      },
    ],
  });
}

export async function generateGroundedContent(approvedSource) {
  const client = getClient();

  const modelInput = {
    product: approvedSource.product,
    facts: approvedSource.facts,
    source_claim_text: approvedSource.source_claim_text,
    approved_claims: approvedSource.approved_claims,
    raw_sources: approvedSource.raw_sources,
  };

  let lastError = null;

  // One retry protects bulk runs from an occasional malformed/no-tool response
  // without multiplying Claude usage excessively.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const message = await requestStructuredContent(client, modelInput);
      const content = extractToolInput(message);

      return {
        model: config.claudeModel,
        usage: message.usage || null,
        content,
        attempts: attempt,
        response_mode: 'forced_tool_schema',
      };
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }

  throw new Error(
    `Claude structured output failed after 2 attempts: ${lastError?.message || String(lastError)}`
  );
}
