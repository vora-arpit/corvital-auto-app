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

You receive three buckets:
1. FACTS — authoritative product/composition/usage facts that may be used automatically.
2. APPROVED_CLAIMS — health/wellness claims explicitly approved by the merchant for use.
3. RAW_SOURCES — audit context only. NEVER use RAW_SOURCES to create health/wellness claims unless the exact claim also appears in APPROVED_CLAIMS.

STRICT RULES
1. Never use outside knowledge, web knowledge, common ingredient knowledge, or assumptions.
2. Never create a health benefit from FACTS alone.
3. A health/wellness/structure-function statement may be used ONLY if its wording is directly supported by APPROVED_CLAIMS.
4. If no approved claim exists for an ingredient, why_in_formula MUST be null.
5. Ingredient identity text may only restate factual identity already present in FACTS (name, chemical expansion, plant source, plant part, standardization, amount). Do not add physiology.
6. Ingredient names and amounts must match FACTS exactly.
7. serving_size, servings_per_container, and suggested_use must be copied exactly from FACTS when present.
8. Never invent marketing headings, timelines, outcomes, mechanisms, studies, certifications, dosage, safety claims, or disease claims.
9. If a requested field is unsupported, return null or [].
10. Return JSON only. No markdown or commentary.

CLAIM TYPES
Use exactly one:
- "fact" — factual product/ingredient identity/composition/usage information supported by FACTS.
- "approved_claim" — a health/wellness claim supported by APPROVED_CLAIMS.
- "unapproved_claim" — a health/wellness or efficacy statement not present in APPROVED_CLAIMS. You should normally never output this; return null instead.
- "disease_claim" — diagnosis/treatment/mitigation/cure/prevention wording. Never generate it.

SOURCE RULES
Every text object must contain:
- source_type: "fact" or "approved_claim"
- source_field: for facts, the exact FACTS key; for approved claims, use "approved_claims"
- source_quote: an exact contiguous quote from that source.

OUTPUT SHAPE
{
  "product_summary": null OR {
    "text": "...",
    "claim_type": "fact|approved_claim|unapproved_claim|disease_claim",
    "source_type": "fact|approved_claim",
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
        "source_quote": "exact quote"
      },
      "why_in_formula": null OR {
        "text": "approved claim only",
        "claim_type": "approved_claim",
        "source_type": "approved_claim",
        "source_field": "approved_claims",
        "source_quote": "exact approved claim"
      }
    }
  ],
  "formula_highlights": [
    {
      "title": "exact ingredient name or factual phrase",
      "amount": null OR "exact amount",
      "text": "factual identity OR approved claim",
      "claim_type": "fact|approved_claim",
      "source_type": "fact|approved_claim",
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
Prefer concise factual content. If APPROVED_CLAIMS is empty, produce no health-benefit language at all.
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
    approved_claims: approvedSource.approved_claims,
    raw_sources: approvedSource.raw_sources,
  };

  const message = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 1600,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `APPROVED_SOURCE:\n${JSON.stringify(modelInput, null, 2)}`,
      },
    ],
  });

  return {
    model: config.claudeModel,
    usage: message.usage || null,
    content: parseClaudeJson(message),
  };
}
