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

The APPROVED_SOURCE is the ONLY source you may use.

STRICT RULES
1. Never use outside knowledge, common ingredient knowledge, web knowledge, assumptions, or inferred benefits.
2. Never invent marketing headings, benefit names, timelines, mechanisms, outcomes, dosage, quantities, certifications, studies, safety claims, disease claims, or scientific claims.
3. Do not strengthen, broaden, summarize into a stronger claim, or add implications that are not explicitly present in the source.
4. If a requested field is not explicitly supported, return null (or [] for arrays).
5. Ingredient names and amounts must come from APPROVED_SOURCE exactly. Do not alter amounts or units.
6. serving_size, servings_per_container, and suggested_use must be copied EXACTLY from APPROVED_SOURCE when present. Never infer them from the ingredient list.
7. Every prose statement must include source_field and source_quote. source_quote must be an exact contiguous quote from the identified source field.
8. Do not add an asterisk unless it is present in the exact source quote.
9. Do not create a "why" or benefit statement from an ingredient merely because that ingredient is commonly associated with a benefit.
10. Do not create timeline language such as days, weeks, months, "results", "you may notice", or "builds over time" unless the exact source explicitly states it. Even if present, classify it as needs-review content.
11. Do not create promotional labels such as "Daily Support", "Plant-Based Support", "Powerful Formula", "Premium Support", or similar invented headings.
12. Return JSON only. No markdown or commentary.

CLAIM CLASSIFICATION
Every prose statement must use exactly one claim_type:
- "objective_fact" = objective product/composition information such as an ingredient amount or non-health product fact.
- "ingredient_identity" = identity/definition only, such as an ingredient's full name, source plant, or chemical expansion, with no physiological or health implication.
- "structure_function_claim" = wording about supporting, maintaining, promoting, or affecting normal body structure or function.
- "general_wellbeing_claim" = wording about vitality, wellness, energy, overall well-being, feeling better, or similar general benefit.
- "disease_claim" = wording that explicitly or implicitly suggests diagnosis, treatment, mitigation, cure, or prevention of disease.
- "other_claim" = any other non-factual marketing or efficacy claim.

IMPORTANT:
- A source-grounded health claim is still a claim. Do NOT classify it as "objective_fact" or "ingredient_identity" simply because it appears in APPROVED_SOURCE.
- If a sentence mixes identity/fact language with a physiological or health effect, classify the whole statement as the appropriate claim type.
- If unsure between an objective/identity type and another type, choose the non-objective claim type.

OUTPUT SHAPE
{
  "product_summary": null OR {
    "text": "...",
    "claim_type": "objective_fact|ingredient_identity|structure_function_claim|general_wellbeing_claim|disease_claim|other_claim",
    "source_field": "...",
    "source_quote": "exact quote"
  },
  "ingredient_story": [
    {
      "name": "exact source ingredient name",
      "amount": null OR "exact source amount",
      "what_it_is": null OR {
        "text": "...",
        "claim_type": "objective_fact|ingredient_identity|structure_function_claim|general_wellbeing_claim|disease_claim|other_claim",
        "source_field": "...",
        "source_quote": "exact quote"
      },
      "why_in_formula": null OR {
        "text": "...",
        "claim_type": "objective_fact|ingredient_identity|structure_function_claim|general_wellbeing_claim|disease_claim|other_claim",
        "source_field": "...",
        "source_quote": "exact quote"
      }
    }
  ],
  "formula_highlights": [
    {
      "title": "exact source-backed ingredient name or factual phrase only",
      "amount": null OR "exact source amount",
      "text": "...",
      "claim_type": "objective_fact|ingredient_identity|structure_function_claim|general_wellbeing_claim|disease_claim|other_claim",
      "source_field": "...",
      "source_quote": "exact quote"
    }
  ],
  "usage_display": null OR {
    "serving_size": null OR "exact source value",
    "servings_per_container": null OR "exact source value",
    "suggested_use": null OR "exact source value"
  },
  "compliance": {
    "requires_review": false,
    "issues": []
  }
}

PUBLISHING INTENT
Prefer objective factual or ingredient-identity content. Health/wellness claims may be returned only when explicitly present in APPROVED_SOURCE and must be classified accurately so the application can hold them for review.
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

  const message = await client.messages.create({
    model: config.claudeModel,
    max_tokens: 1800,
    temperature: 0,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `APPROVED_SOURCE:\n${JSON.stringify(approvedSource, null, 2)}`,
      },
    ],
  });

  return {
    model: config.claudeModel,
    usage: message.usage || null,
    content: parseClaudeJson(message),
  };
}
