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

STRICT SOURCE-GROUNDING RULES:
1. Use ONLY facts explicitly present in APPROVED_SOURCE.
2. Never use outside knowledge, common ingredient knowledge, web knowledge, or assumptions.
3. Never invent or infer health benefits, mechanisms, timelines, dosage, expected outcomes, efficacy, certifications, studies, safety claims, disease claims, or scientific claims.
4. Do not strengthen or broaden source wording.
5. Do not create wording that claims or implies diagnosis, treatment, mitigation, cure, or prevention of disease.
6. If a requested field is not explicitly supported, return null (or [] for arrays).
7. serving_size, servings_per_container, and suggested_use must be copied EXACTLY from APPROVED_SOURCE when present. Do not rewrite them.
8. Every editorial claim must include source_field and source_quote. source_quote must be an exact contiguous quote from that source field.
9. Do not add an asterisk to a claim unless the source itself contains it.
10. Return JSON only. No markdown and no commentary.

OUTPUT SHAPE:
{
  "product_summary": null OR {
    "text": "...",
    "source_field": "description_clean",
    "source_quote": "exact quote"
  },
  "ingredient_story": null OR {
    "name": "...",
    "amount": null OR "...",
    "what_it_is": null OR {
      "text": "...",
      "source_field": "...",
      "source_quote": "exact quote"
    },
    "why_in_formula": null OR {
      "text": "...",
      "source_field": "...",
      "source_quote": "exact quote"
    }
  },
  "formula_highlights": [
    {
      "title": "...",
      "amount": null OR "...",
      "text": "...",
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
