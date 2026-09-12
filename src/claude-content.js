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
12. Return JSON only. No markdown or commentary.

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

OUTPUT SHAPE
{
  "product_summary": null OR {
    "text": "...",
    "claim_type": "fact|source_claim|approved_claim|disease_claim",
    "source_type": "fact|source_claim|approved_claim",
    "source_field": "...",
    "source_quote": "exact quote"
  },
  "ingredient_story": [
    {
      "name": "exact ingredient name from FACTS",
      "amount": null OR "exact amount from FACTS",
      "what_it_is": null OR {
        "text": "factual identity only",
        "claim_type": "fact",
        "source_type": "fact",
        "source_field": "ingredients|ingredient_highlights",
        "source_quote": "exact quote where practical"
      },
      "why_in_formula": null OR {
        "text": "exact source-backed claim",
        "claim_type": "source_claim|approved_claim",
        "source_type": "source_claim|approved_claim",
        "source_field": "description_clean|approved_claims",
        "source_quote": "exact claim"
      }
    }
  ],
  "formula_highlights": [
    {
      "title": "exact ingredient name",
      "amount": null OR "exact amount",
      "text": "factual identity OR exact source-backed claim",
      "claim_type": "fact|source_claim|approved_claim",
      "source_type": "fact|source_claim|approved_claim",
      "source_field": "...",
      "source_quote": "exact quote"
    }
  ],
  "usage_display": null OR {
    "serving_size": null OR "exact FACTS value",
    "servings_per_container": null OR "exact FACTS value",
    "suggested_use": null OR "exact FACTS value"
  },
  "compliance": {
    "requires_review": false,
    "issues": []
  }
}

PREFERENCE
Use useful source-backed "supports", "helps maintain", "promotes", and similar structure/function/general-wellness wording when it is present in SOURCE_CLAIM_TEXT. Do not omit such claims merely because APPROVED_CLAIMS is empty.
`.trim();

function parseClaudeJson(message) {
  const text = (message?.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!text) throw new Error('Claude returned an empty response.');

  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw new Error(`Claude returned invalid JSON: ${error.message}`);
  }
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

  const message = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 1800,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `PRODUCT_SOURCE:\n${JSON.stringify(modelInput, null, 2)}`,
      },
    ],
  });

  return {
    model: config.claudeModel,
    usage: message.usage || null,
    content: parseClaudeJson(message),
  };
}
