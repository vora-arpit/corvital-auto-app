import * as cheerio from 'cheerio';

const SECTION_DEFS = [
  { key: 'ingredients', type: 'multi_line_text_field', aliases: ['ingredients', 'ingredient'] },
  { key: 'other_ingredients', type: 'multi_line_text_field', aliases: ['other ingredients', 'inactive ingredients', 'additional ingredients'] },
  { key: 'contains', type: 'multi_line_text_field', aliases: ['contains', 'allergens', 'allergen information', 'allergen statement'] },
  { key: 'manufacturer_country', type: 'single_line_text_field', aliases: ["manufacturer's country", 'manufacturer country', 'manufacturers country', 'country of manufacture', 'country of origin'] },
  { key: 'product_amount', type: 'single_line_text_field', aliases: ['product amount', 'amount per container', 'product quantity', 'amount'] },
  { key: 'gross_weight', type: 'single_line_text_field', aliases: ['gross weight', 'net weight'] },
  { key: 'serving_size', type: 'single_line_text_field', aliases: ['serving size'] },
  { key: 'servings_per_container', type: 'single_line_text_field', aliases: ['servings per container', 'servings per bottle'] },
  { key: 'suggested_use', type: 'multi_line_text_field', aliases: ['suggested use', 'suggested usage', 'directions', 'directions for use', 'recommended use', 'recommended usage', 'how to use'] },
  { key: 'caution', type: 'multi_line_text_field', aliases: ['caution', 'cautions'] },
  { key: 'iron_warning', type: 'multi_line_text_field', aliases: ['iron warning'] },
  { key: 'warning', type: 'multi_line_text_field', aliases: ['warning', 'warnings'] },
  { key: 'storage', type: 'multi_line_text_field', aliases: ['storage', 'storage instructions', 'storage information'] },
];

export const METAFIELD_TYPES = {
  description_clean: 'multi_line_text_field',
  ingredients: 'multi_line_text_field',
  other_ingredients: 'multi_line_text_field',
  contains: 'multi_line_text_field',
  manufacturer_country: 'single_line_text_field',
  product_amount: 'single_line_text_field',
  gross_weight: 'single_line_text_field',
  serving_size: 'single_line_text_field',
  servings_per_container: 'single_line_text_field',
  suggested_use: 'multi_line_text_field',
  caution: 'multi_line_text_field',
  iron_warning: 'multi_line_text_field',
  warning: 'multi_line_text_field',
  storage: 'multi_line_text_field',
  fda_disclaimer: 'multi_line_text_field',
  product_attributes: 'list.single_line_text_field',
};

const ATTRIBUTE_CANONICAL = [
  'Gluten-free', 'Vegetarian', 'Lactose-free', 'Allergen-free', 'Hormone-free',
  'All natural', 'Antibiotic-free', 'Non-GMO', 'Corn-free', 'Vegan friendly',
  'Alcohol Free', 'Halal', 'Kosher', 'Soy-free', 'Sugar-free', 'Dairy-free',
  'GMO-free', 'Cruelty-free', 'Organic', 'Keto friendly', 'Paleo friendly'
];

const ATTRIBUTE_LOOKUP = new Map(ATTRIBUTE_CANONICAL.map(v => [normalizeAttributeKey(v), v]));

function normalizeAttributeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[_\s]+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .trim();
}

function htmlToPlainText(html) {
  const $ = cheerio.load(html || '', null, false);

  // Make bold Supliful labels explicit lines before extracting text.
  $('strong,b').each((_, el) => {
    $(el).before('\n').after('\n');
  });
  $('br').replaceWith('\n');
  $('p,div,li,h1,h2,h3,h4,h5,h6').each((_, el) => {
    $(el).append('\n');
  });
  $('img').remove();

  return $.root().text()
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractAttributes(html) {
  const $ = cheerio.load(html || '', null, false);
  const found = [];
  const add = (candidate) => {
    if (!candidate) return;
    const cleaned = String(candidate).replace(/\s+/g, ' ').trim();
    const direct = ATTRIBUTE_LOOKUP.get(normalizeAttributeKey(cleaned));
    if (direct && !found.includes(direct)) found.push(direct);
  };

  $('img').each((_, el) => {
    add($(el).attr('alt'));
    add($(el).attr('title'));
    add($(el).attr('aria-label'));
  });
  $('a').each((_, el) => {
    add($(el).text());
    add($(el).attr('title'));
    add($(el).attr('aria-label'));
    const img = $(el).find('img').first();
    if (img.length) {
      add(img.attr('alt'));
      add(img.attr('title'));
    }
  });

  // Whitelist fallback: useful when Shopify/Supliful flattens labels oddly.
  const source = $.root().text() + ' ' + (html || '');
  for (const canonical of ATTRIBUTE_CANONICAL) {
    const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/-/g, '[-\\s]?');
    if (new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`, 'i').test(source) && !found.includes(canonical)) {
      found.push(canonical);
    }
  }
  return found;
}

function normalizeUnits(value) {
  return String(value || '')
    .replace(/^\s*\(\s*oz\s*\/\s*lbs?\s*\/\s*g\s*\)\s*:\s*/i, '')
    .replace(/^\s*oz\s*\/\s*lbs?\s*\/\s*g\s*:\s*/i, '')
    .replace(/(\d)\s*(oz|lbs?|g|mg|mcg|ml)\b/gi, '$1 $2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function cleanValue(key, value) {
  let v = String(value || '').replace(/\u00a0/g, ' ').trim();
  v = v.replace(/^[:\-–—\s]+/, '').trim();
  if (['product_amount', 'gross_weight'].includes(key)) v = normalizeUnits(v);
  if (key === 'fda_disclaimer') {
    v = v.replace(/^\*+/, '').trim();
    v = v.replace(/Administration\.\s*\.\s*/i, 'Administration. ');
    v = v.replace(/\s+([.,;:])/g, '$1');
  }
  return v;
}

function detectHeading(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  const fda = raw.match(/^\*?\s*these statements have not been evaluated by the food and drug administration\.?\s*(.*)$/i);
  if (fda) {
    return {
      key: 'fda_disclaimer',
      type: METAFIELD_TYPES.fda_disclaimer,
      initial: `These statements have not been evaluated by the Food and Drug Administration. ${fda[1] || ''}`.trim(),
    };
  }

  for (const def of SECTION_DEFS) {
    for (const alias of def.aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Optional parenthetical annotation supports e.g. Product amount (oz/lb/g):
      const re = new RegExp(`^\\*?\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s*:\\s*(.*)$`, 'i');
      const match = raw.match(re);
      if (match) return { key: def.key, type: def.type, initial: match[1] || '' };

      // Strong tags are sometimes flattened to "Amount" on its own line.
      const plainRe = new RegExp(`^\\*?\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s*$`, 'i');
      if (plainRe.test(raw)) return { key: def.key, type: def.type, initial: '' };
    }
  }
  return null;
}

export function parseSuplifulDescription(descriptionHtml) {
  const plain = htmlToPlainText(descriptionHtml);
  const attributes = extractAttributes(descriptionHtml);
  const lines = plain.split(/\n+/).map(v => v.trim()).filter(Boolean);

  const result = {};
  const descriptionLines = [];
  let current = null;
  let bucket = [];

  const flush = () => {
    if (!current) return;
    const combined = [current.initial, ...bucket].filter(Boolean).join('\n').trim();
    const cleaned = cleanValue(current.key, combined);
    if (cleaned) result[current.key] = cleaned;
    current = null;
    bucket = [];
  };

  for (const line of lines) {
    const heading = detectHeading(line);
    if (heading) {
      flush();
      current = heading;
      continue;
    }

    if (current) bucket.push(line);
    else descriptionLines.push(line);
  }
  flush();

  let description = descriptionLines.join('\n').trim();
  description = description.replace(/\*+\s*$/, '').trim();
  if (description) result.description_clean = description;

  if (attributes.length) result.product_attributes = attributes;
  return result;
}

export function toMetafieldValue(key, value) {
  if (key === 'product_attributes') return JSON.stringify(Array.isArray(value) ? value : []);
  return String(value ?? '').trim();
}
