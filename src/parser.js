import * as cheerio from 'cheerio';
import { deriveServingInfo } from './serving-utils.js';

/* ============================================================
   CORVITAL PLUS — SUPLIFUL DESCRIPTION PARSER
   STAGE 1: STRUCTURED INGREDIENT HIGHLIGHTS
   ------------------------------------------------------------
   Goals:
   - Preserve real marketing paragraphs
   - Ignore cosmetic <br> line breaks inside paragraphs
   - Parse Supliful labeled fields
   - Extract product attributes / certifications
   - Normalize product amount + weight formatting
   - Preserve source ingredient values
   - NEW: generate deterministic ingredient highlights
============================================================ */


/* ============================================================
   SECTION DEFINITIONS
============================================================ */

const SECTION_DEFS = [
  {
    key: 'ingredients',
    type: 'multi_line_text_field',
    aliases: [
      'ingredients',
      'ingredient'
    ]
  },

  {
    key: 'other_ingredients',
    type: 'multi_line_text_field',
    aliases: [
      'other ingredients',
      'inactive ingredients',
      'additional ingredients'
    ]
  },

  {
    key: 'contains',
    type: 'multi_line_text_field',
    aliases: [
      'contains',
      'allergens',
      'allergen information',
      'allergen statement'
    ]
  },

  {
    key: 'manufacturer_country',
    type: 'single_line_text_field',
    aliases: [
      "manufacturer's country",
      'manufacturer country',
      'manufacturers country',
      'country of manufacture',
      'country of origin'
    ]
  },

  {
    key: 'product_amount',
    type: 'single_line_text_field',
    aliases: [
      'product amount',
      'amount per container',
      'product quantity',
      'amount'
    ]
  },

  {
    key: 'gross_weight',
    type: 'single_line_text_field',
    aliases: [
      'gross weight',
      'net weight'
    ]
  },

  {
    key: 'serving_size',
    type: 'single_line_text_field',
    aliases: [
      'serving size'
    ]
  },

  {
    key: 'servings_per_container',
    type: 'single_line_text_field',
    aliases: [
      'servings per container',
      'servings per bottle'
    ]
  },

  {
    key: 'suggested_use',
    type: 'multi_line_text_field',
    aliases: [
      'suggested use',
      'suggested usage',
      'directions',
      'directions for use',
      'recommended use',
      'recommended usage',
      'how to use'
    ]
  },

  {
    key: 'caution',
    type: 'multi_line_text_field',
    aliases: [
      'caution',
      'cautions'
    ]
  },

  {
    key: 'iron_warning',
    type: 'multi_line_text_field',
    aliases: [
      'iron warning'
    ]
  },

  {
    key: 'warning',
    type: 'multi_line_text_field',
    aliases: [
      'warning',
      'warnings'
    ]
  },

  {
    key: 'storage',
    type: 'multi_line_text_field',
    aliases: [
      'storage',
      'storage instructions',
      'storage information'
    ]
  }
];


/* ============================================================
   SHOPIFY METAFIELD TYPES
============================================================ */

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
  serving_derivation: 'json',

  suggested_use: 'multi_line_text_field',
  caution: 'multi_line_text_field',
  iron_warning: 'multi_line_text_field',
  warning: 'multi_line_text_field',
  storage: 'multi_line_text_field',

  fda_disclaimer: 'multi_line_text_field',

  product_attributes: 'list.single_line_text_field',

  /* NEW — Stage 1 */
  ingredient_highlights: 'json'
};


/* ============================================================
   PRODUCT ATTRIBUTES
============================================================ */

const ATTRIBUTE_CANONICAL = [
  'Gluten-free',
  'Vegetarian',
  'Lactose-free',
  'Allergen-free',
  'Hormone-free',
  'All natural',
  'Antibiotic-free',
  'Non-GMO',
  'Corn-free',
  'Vegan friendly',
  'Alcohol Free',
  'Halal',
  'Kosher',
  'Soy-free',
  'Sugar-free',
  'Dairy-free',
  'GMO-free',
  'Cruelty-free',
  'Organic',
  'Keto friendly',
  'Paleo friendly'
];


function normalizeAttributeKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[_\s]+/g, ' ')
    .replace(/\s*-\s*/g, '-')
    .trim();
}


const ATTRIBUTE_LOOKUP = new Map(
  ATTRIBUTE_CANONICAL.map((value) => [
    normalizeAttributeKey(value),
    value
  ])
);


/* ============================================================
   GENERAL TEXT HELPERS
============================================================ */

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}


/* ============================================================
   MARKETING DESCRIPTION HTML -> TEXT
============================================================ */

function htmlToParagraphText(html) {
  const $ = cheerio.load(html || '', null, false);

  $('img').remove();

  /*
    Cosmetic <br> tags become spaces.
  */
  $('br').replaceWith(' ');

  /*
    Actual block elements become paragraph boundaries.
  */
  $('p,div,h1,h2,h3,h4,h5,h6,blockquote').each((_, el) => {
    $(el).append('\n\n');
  });

  $('li').each((_, el) => {
    $(el).append('\n');
  });

  let text = $.root().text();

  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return text;
}


/* ============================================================
   STRUCTURED SECTION HTML -> TEXT
============================================================ */

function htmlToSectionText(html) {
  const $ = cheerio.load(html || '', null, false);

  $('strong,b').each((_, el) => {
    $(el).before('\n').after('\n');
  });

  $('br').replaceWith('\n');

  $('p,div,li,h1,h2,h3,h4,h5,h6').each((_, el) => {
    $(el).append('\n');
  });

  $('img').remove();

  return $.root()
    .text()
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


/* ============================================================
   ATTRIBUTE EXTRACTION
============================================================ */

function extractAttributes(html) {
  const $ = cheerio.load(html || '', null, false);

  const found = [];

  const add = (candidate) => {
    if (!candidate) return;

    const cleaned = String(candidate)
      .replace(/\s+/g, ' ')
      .trim();

    const direct = ATTRIBUTE_LOOKUP.get(
      normalizeAttributeKey(cleaned)
    );

    if (direct && !found.includes(direct)) {
      found.push(direct);
    }
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
      add(img.attr('aria-label'));
    }
  });


  const source =
    `${$.root().text()} ${html || ''}`;

  for (const canonical of ATTRIBUTE_CANONICAL) {
    const escaped = canonical
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/-/g, '[-\\s]?');

    const pattern = new RegExp(
      `(?:^|[^a-z])${escaped}(?:$|[^a-z])`,
      'i'
    );

    if (
      pattern.test(source) &&
      !found.includes(canonical)
    ) {
      found.push(canonical);
    }
  }

  return found;
}


/* ============================================================
   UNIT NORMALIZATION
============================================================ */

function normalizeUnits(value) {
  return String(value || '')

    .replace(
      /^\s*\(\s*oz\s*\/\s*lbs?\s*\/\s*g\s*\)\s*:\s*/i,
      ''
    )

    .replace(
      /^\s*oz\s*\/\s*lbs?\s*\/\s*g\s*:\s*/i,
      ''
    )

    .replace(
      /(\d)\s*(oz|lbs?|g|mg|mcg|ml)\b/gi,
      '$1 $2'
    )

    .replace(/\s{2,}/g, ' ')
    .trim();
}


/* ============================================================
   CLEAN STRUCTURED VALUES
============================================================ */

function cleanValue(key, value) {
  let v = String(value || '')
    .replace(/\u00a0/g, ' ')
    .trim();

  v = v
    .replace(/^[:\-–—\s]+/, '')
    .trim();


  if (
    key === 'product_amount' ||
    key === 'gross_weight'
  ) {
    v = normalizeUnits(v);
  }


  if (key === 'fda_disclaimer') {
    v = v
      .replace(/^\*+/, '')
      .trim();

    v = v.replace(
      /Administration\.\s*\.\s*/i,
      'Administration. '
    );

    v = v.replace(
      /\s+([.,;:])/g,
      '$1'
    );
  }


  if (
    METAFIELD_TYPES[key] === 'multi_line_text_field'
  ) {
    v = v
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/(?<!\n)\n(?!\n)/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    v = v
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return v;
}


/* ============================================================
   HEADING DETECTION
============================================================ */

function escapeRegex(value) {
  return String(value || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function detectHeading(line) {
  const raw = String(line || '').trim();

  if (!raw) return null;


  const fda = raw.match(
    /^\*?\s*these statements have not been evaluated by the food and drug administration\.?\s*(.*)$/i
  );

  if (fda) {
    return {
      key: 'fda_disclaimer',
      type: METAFIELD_TYPES.fda_disclaimer,
      initial:
        `These statements have not been evaluated by the Food and Drug Administration. ${fda[1] || ''}`.trim()
    };
  }


  for (const def of SECTION_DEFS) {
    for (const alias of def.aliases) {
      const escaped = escapeRegex(alias);

      const withColon = new RegExp(
        `^\\*?\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s*:\\s*(.*)$`,
        'i'
      );

      const match = raw.match(withColon);

      if (match) {
        return {
          key: def.key,
          type: def.type,
          initial: match[1] || ''
        };
      }


      const standalone = new RegExp(
        `^\\*?\\s*${escaped}(?:\\s*\\([^)]*\\))?\\s*$`,
        'i'
      );

      if (standalone.test(raw)) {
        return {
          key: def.key,
          type: def.type,
          initial: ''
        };
      }
    }
  }


  return null;
}


/* ============================================================
   FIND FIRST STRUCTURED SECTION
============================================================ */

function findFirstStructuredHeadingLine(sectionText) {
  const lines = String(sectionText || '')
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    if (detectHeading(lines[i])) {
      return {
        index: i,
        lines
      };
    }
  }

  return {
    index: -1,
    lines
  };
}


/* ============================================================
   CLEAN MARKETING DESCRIPTION
============================================================ */

function cleanMarketingDescription(value) {
  let text = String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '');


  text = text
    .split(/\n{2,}/)
    .map((paragraph) => {
      return paragraph
        .replace(/\n+/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim();
    })
    .filter(Boolean)
    .join('\n\n');


  text = text
    .replace(/\*+\s*$/, '')
    .trim();


  return text;
}


/* ============================================================
   EXTRACT MARKETING DESCRIPTION
============================================================ */

function extractMarketingDescription(descriptionHtml) {
  const $ = cheerio.load(
    descriptionHtml || '',
    null,
    false
  );


  $('img').remove();

  let firstStructuredNode = null;


  $('strong,b').each((_, el) => {
    if (firstStructuredNode) return;

    const label = $(el)
      .text()
      .replace(/\u00a0/g, ' ')
      .trim();

    if (detectHeading(label)) {
      firstStructuredNode = el;
    }
  });


  if (!firstStructuredNode) {
    $('p,div,li,h1,h2,h3,h4,h5,h6').each((_, el) => {
      if (firstStructuredNode) return;

      const text = $(el)
        .text()
        .replace(/\u00a0/g, ' ')
        .trim();

      const firstPart = text.slice(0, 200);

      if (detectHeading(firstPart)) {
        firstStructuredNode = el;
      }
    });
  }


  if (firstStructuredNode) {
    let node = $(firstStructuredNode);

    const block = node.closest(
      'p,li,h1,h2,h3,h4,h5,h6'
    );

    if (block.length) {
      node = block;
    }

    node.nextAll().remove();
    node.remove();
  }


  const remainingHtml = $.root().html() || '';

  return cleanMarketingDescription(
    htmlToParagraphText(remainingHtml)
  );
}


/* ============================================================
   STAGE 1 — INGREDIENT HIGHLIGHT EXTRACTION
============================================================ */


/*
   We deliberately avoid using a simple:

   ingredients.split(',')

   because ingredient names often contain commas INSIDE
   parentheses.

   Example:

   Proprietary Blend (PABA, Horsetail, Fo-Ti, Bamboo)

   must remain ONE ingredient.

   This splitter only separates commas at the top level.
*/

function splitTopLevelIngredients(value) {
  const source = String(value || '').trim();

  if (!source) return [];

  const parts = [];

  let buffer = '';
  let roundDepth = 0;
  let squareDepth = 0;
  let curlyDepth = 0;

  for (let i = 0; i < source.length; i++) {
    const char = source[i];

    if (char === '(') roundDepth++;
    else if (char === ')') {
      roundDepth = Math.max(0, roundDepth - 1);
    }

    else if (char === '[') squareDepth++;
    else if (char === ']') {
      squareDepth = Math.max(0, squareDepth - 1);
    }

    else if (char === '{') curlyDepth++;
    else if (char === '}') {
      curlyDepth = Math.max(0, curlyDepth - 1);
    }


    const atTopLevel =
      roundDepth === 0 &&
      squareDepth === 0 &&
      curlyDepth === 0;


    if (
      char === ',' &&
      atTopLevel
    ) {
      const item = buffer.trim();

      if (item) {
        parts.push(item);
      }

      buffer = '';
      continue;
    }


    buffer += char;
  }


  const lastItem = buffer.trim();

  if (lastItem) {
    parts.push(lastItem);
  }


  return parts;
}


/* ============================================================
   INGREDIENT CLASSIFICATION HELPERS
============================================================ */

const CAPSULE_PATTERNS = [
  /\bhpmc\b/i,
  /\bhypromellose\b/i,
  /\bvegetable capsule\b/i,
  /\bvegetarian capsule\b/i,
  /\bvegan capsule\b/i,
  /\bcapsule shell\b/i,
  /\bgelatin capsule\b/i
];


const EXCIPIENT_PATTERNS = [
  /\bmagnesium stearate\b/i,
  /\bsilicon dioxide\b/i,
  /\bsilica\b/i,
  /\brice flour\b/i,
  /\bbrown rice flour\b/i,
  /\bmicrocrystalline cellulose\b/i,
  /\bmcc\b/i,
  /\bcellulose\b/i,
  /\bstearic acid\b/i,
  /\bcalcium silicate\b/i,
  /\bmaltodextrin\b/i,
  /\bleucine\b/i,
  /\bvegetable oil\b/i,
  /\bolive oil\b/i
];


function matchesAny(value, patterns) {
  const source = String(value || '');

  return patterns.some((pattern) =>
    pattern.test(source)
  );
}


function isCapsuleIngredient(value) {
  return matchesAny(
    value,
    CAPSULE_PATTERNS
  );
}


function isKnownExcipient(value) {
  return matchesAny(
    value,
    EXCIPIENT_PATTERNS
  );
}


/* ============================================================
   EXTRACT AMOUNT FROM ONE INGREDIENT
============================================================ */

/*
   Supports examples such as:

   NAD+ (...) (500 mg)

   Magnesium (...) 275mg

   Vitamin A (...) 120mcg RAE

   Folate 1496mcg DFE (880mcg Folic Acid)

   CoQ10 200 mg

   Vitamin D3 5000 IU
*/

function extractIngredientAmount(value) {
  const source = String(value || '').trim();

  if (!source) {
    return {
      amount: '',
      name: ''
    };
  }


  /*
    First preference:
    final parenthetical amount.

    Example:
    NAD+ (...) (500 mg)
  */
  const finalParenAmount = source.match(
    /\(\s*([\d,.]+\s*(?:mg|mcg|g|iu|cfu|ml|µg)(?:\s+(?:RAE|DFE))?)\s*\)\s*\.?$/i
  );

  if (finalParenAmount) {
    const amount =
      normalizeIngredientAmount(
        finalParenAmount[1]
      );

    const name = source
      .slice(
        0,
        finalParenAmount.index
      )
      .trim()
      .replace(/[;,]+$/, '')
      .trim();

    return {
      amount,
      name
    };
  }


  /*
    End-of-entry amount.

    Examples:
    Magnesium (...) 275mg
    Vitamin D3 5000 IU
    Vitamin A (...) 120mcg RAE
  */
  const endingAmount = source.match(
    /([\d,.]+\s*(?:mg|mcg|g|iu|cfu|ml|µg)(?:\s+(?:RAE|DFE))?)\s*\.?$/i
  );

  if (endingAmount) {
    const amount =
      normalizeIngredientAmount(
        endingAmount[1]
      );

    const name = source
      .slice(
        0,
        endingAmount.index
      )
      .trim()
      .replace(/[;,]+$/, '')
      .trim();

    return {
      amount,
      name
    };
  }


  return {
    amount: '',
    name: source
      .replace(/[;,]+$/, '')
      .trim()
  };
}


function normalizeIngredientAmount(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(
      /([\d,.])\s*(mg|mcg|g|iu|cfu|ml|µg)\b/gi,
      '$1 $2'
    )
    .replace(/\s{2,}/g, ' ')
    .trim();
}


/* ============================================================
   CLEAN DISPLAY NAME
============================================================ */

function cleanIngredientDisplayName(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,;:\-\s]+/, '')
    .replace(/[,;:\-\s]+$/, '')
    .trim();
}


/* ============================================================
   CAPSULE DETAIL
============================================================ */

function getCapsuleDetail(value) {
  const source = String(value || '');

  if (
    /hpmc|hypromellose|vegetable capsule|vegetarian capsule|vegan capsule/i.test(
      source
    )
  ) {
    return 'Vegetable capsule';
  }


  if (/gelatin capsule/i.test(source)) {
    return 'Gelatin capsule';
  }


  if (/capsule shell/i.test(source)) {
    return 'Capsule shell';
  }


  return 'Capsule material';
}


/* ============================================================
   PARSE ONE INGREDIENT
============================================================ */

function parseIngredientEntry(entry, sourceIndex) {
  const raw =
    cleanIngredientDisplayName(entry);

  if (!raw) return null;


  const {
    amount,
    name: extractedName
  } = extractIngredientAmount(raw);


  let name =
    cleanIngredientDisplayName(
      extractedName
    );


  if (!name) {
    name = raw;
  }


  let kind = 'ingredient';
  let detail = '';


  if (isCapsuleIngredient(raw)) {
    kind = 'capsule';
    detail = getCapsuleDetail(raw);


    /*
      Clean common capsule wording for display.

      Example:

      HPMC (vegetable capsule)
      becomes:
      name = HPMC
      detail = Vegetable capsule
    */
    name = name
      .replace(
        /\s*\((?:vegetable|vegetarian|vegan)\s+capsule\)\s*/i,
        ''
      )
      .replace(
        /\s*\(capsule\)\s*/i,
        ''
      )
      .trim();
  }

  else if (amount) {
    /*
      Explicit dosage is our strongest deterministic
      indication that this is a highlighted active/nutrient.
    */
    kind = 'active';
  }

  else if (isKnownExcipient(raw)) {
    kind = 'other';
    detail = 'Other ingredient';
  }

  else {
    /*
      No amount and not a known excipient.

      We intentionally call this simply "ingredient",
      not "active", because we do not want the parser
      to make an unsupported classification.
    */
    kind = 'ingredient';
  }


  return {
    name,
    amount,
    detail,
    kind,
    source_index: sourceIndex
  };
}


/* ============================================================
   SELECT INGREDIENT HIGHLIGHTS
============================================================ */

/*
   Maximum displayed highlight candidates.

   We are storing the selected candidates now.
   Later our "Inside the Capsule" Liquid section will
   render these automatically.
*/

const MAX_INGREDIENT_HIGHLIGHTS = 4;


function selectIngredientHighlights(entries) {
  const valid = entries.filter(Boolean);

  if (!valid.length) return [];


  const actives =
    valid.filter(
      (entry) =>
        entry.kind === 'active'
    );


  const normalIngredients =
    valid.filter(
      (entry) =>
        entry.kind === 'ingredient'
    );


  const capsules =
    valid.filter(
      (entry) =>
        entry.kind === 'capsule'
    );


  const others =
    valid.filter(
      (entry) =>
        entry.kind === 'other'
    );


  /*
    Priority:

    1. Ingredients with explicit amounts
    2. Formula ingredients without explicit amounts
    3. Capsule material
    4. Other/excipient ingredients

    This means:

    NAD+:
      NAD+
      Quercetin
      Japanese Knotweed
      HPMC

    Turmeric:
      Turmeric Root
      Glucosamine
      Turmeric Curcuminoids
      Ginger

    Simple single-active formula:
      Active
      capsule
      other
      other
  */

  const ordered = [
    ...actives,
    ...normalIngredients,
    ...capsules,
    ...others
  ];


  const selected = [];
  const seen = new Set();


  for (const entry of ordered) {
    if (
      selected.length >=
      MAX_INGREDIENT_HIGHLIGHTS
    ) {
      break;
    }


    const dedupeKey =
      entry.name
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();


    if (!dedupeKey) continue;

    if (seen.has(dedupeKey)) {
      continue;
    }


    seen.add(dedupeKey);


    selected.push({
      name: entry.name,
      amount: entry.amount || '',
      detail: entry.detail || '',
      kind: entry.kind
    });
  }


  return selected;
}


/* ============================================================
   EXTRACT INGREDIENT HIGHLIGHTS FROM FULL INGREDIENT STRING
============================================================ */

function extractIngredientHighlights(
  ingredients,
  otherIngredients = ''
) {
  const primaryParts =
    splitTopLevelIngredients(
      ingredients
    );


  const secondaryParts =
    splitTopLevelIngredients(
      otherIngredients
    );


  const parsed = [];


  primaryParts.forEach(
    (entry, index) => {
      const item =
        parseIngredientEntry(
          entry,
          index
        );

      if (item) {
        parsed.push(item);
      }
    }
  );


  /*
    Other Ingredients are appended AFTER primary ingredients.

    This prevents secondary excipients from taking priority
    over the actual formula ingredients.
  */
  secondaryParts.forEach(
    (entry, index) => {
      const item =
        parseIngredientEntry(
          entry,
          primaryParts.length + index
        );

      if (item) {
        /*
          If this came specifically from an
          Other Ingredients section and doesn't have an amount,
          treat it as an "other" ingredient unless it's
          explicitly capsule material.
        */
        if (
          item.kind === 'ingredient'
        ) {
          item.kind = 'other';

          if (!item.detail) {
            item.detail =
              'Other ingredient';
          }
        }

        parsed.push(item);
      }
    }
  );


  return selectIngredientHighlights(
    parsed
  );
}




/* ============================================================
   STRICT FALLBACK EXTRACTION FOR SERVING FIELDS
   ------------------------------------------------------------
   Some Supliful descriptions place Serving Size / Servings Per
   Container inline with other markup, which can cause the normal
   line-based section parser to miss them. These helpers only
   recover EXPLICITLY STATED values from the source text. They do
   not calculate or infer servings from capsule count or dosage.
============================================================ */

function extractExplicitLabeledValue(sectionText, aliases) {
  const source = String(sectionText || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();

  if (!source) return '';

  const allAliases = SECTION_DEFS.flatMap((def) => def.aliases);
  const nextLabelPattern = allAliases
    .map((alias) => escapeRegex(alias))
    .sort((a, b) => b.length - a.length)
    .join('|');

  for (const alias of aliases) {
    const escaped = escapeRegex(alias);

    const pattern = new RegExp(
      `(?:^|\n|\b)${escaped}\s*(?:\([^)]*\))?\s*[:\-–—]?\s*` +
      `(.+?)(?=\n\s*(?:${nextLabelPattern})\s*(?:\([^)]*\))?\s*[:\-–—]?|$)`,
      'i'
    );

    const match = source.match(pattern);
    if (!match) continue;

    const value = cleanValue(
      alias.toLowerCase().includes('servings per')
        ? 'servings_per_container'
        : 'serving_size',
      match[1]
    );

    if (value) return value;
  }

  return '';
}


/* ============================================================
   MAIN PARSER
============================================================ */

export function parseSuplifulDescription(descriptionHtml) {

  /* ----------------------------------------------------------
     1. Extract attributes
  ---------------------------------------------------------- */

  const attributes =
    extractAttributes(descriptionHtml);


  /* ----------------------------------------------------------
     2. Build section-friendly text
  ---------------------------------------------------------- */

  const sectionText =
    htmlToSectionText(
      descriptionHtml
    );


  const lines = sectionText
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);


  const result = {};

  let current = null;
  let bucket = [];


  /* ----------------------------------------------------------
     Flush structured field
  ---------------------------------------------------------- */

  const flush = () => {
    if (!current) return;

    const combined = [
      current.initial,
      ...bucket
    ]
      .filter(Boolean)
      .join('\n')
      .trim();


    const cleaned =
      cleanValue(
        current.key,
        combined
      );


    if (cleaned) {
      result[current.key] =
        cleaned;
    }


    current = null;
    bucket = [];
  };


  /* ----------------------------------------------------------
     3. Parse structured fields
  ---------------------------------------------------------- */

  for (const line of lines) {
    const heading =
      detectHeading(line);


    if (heading) {
      flush();

      current = heading;

      continue;
    }


    if (current) {
      bucket.push(line);
    }
  }


  flush();


  /* ----------------------------------------------------------
     3B. Conservative serving-field fallback
     Only recover values that are explicitly labeled in the
     source. Never infer serving size or servings per container.
  ---------------------------------------------------------- */

  if (!result.serving_size) {
    const explicitServingSize = extractExplicitLabeledValue(
      sectionText,
      ['serving size']
    );

    if (explicitServingSize) {
      result.serving_size = explicitServingSize;
    }
  }

  if (!result.servings_per_container) {
    const explicitServingsPerContainer = extractExplicitLabeledValue(
      sectionText,
      ['servings per container', 'servings per bottle']
    );

    if (explicitServingsPerContainer) {
      result.servings_per_container = explicitServingsPerContainer;
    }
  }


  /* ----------------------------------------------------------
     3C. Deterministic serving derivation
     If explicit Supplement Facts values are absent, derive only
     from authoritative suggested_use + product_amount.

     Example:
       suggested_use: "take two (2) capsules daily"
       product_amount: "60 capsules / ..."
       -> serving_size: "2 capsules"
       -> servings_per_container: "30"

     Ambiguous ranges / multi-dose instructions are refused.
  ---------------------------------------------------------- */

  if (!result.serving_size || !result.servings_per_container) {
    const derivedServing = deriveServingInfo({
      suggested_use: result.suggested_use,
      product_amount: result.product_amount,
    });

    let usedDerivation = false;

    if (!result.serving_size && derivedServing.serving_size) {
      result.serving_size = derivedServing.serving_size;
      usedDerivation = true;
    }

    if (!result.servings_per_container && derivedServing.servings_per_container) {
      result.servings_per_container = derivedServing.servings_per_container;
      usedDerivation = true;
    }

    if (usedDerivation) {
      result.serving_derivation = derivedServing.derivation;
    }
  }


  /* ----------------------------------------------------------
     4. Marketing description
  ---------------------------------------------------------- */

  let description =
    extractMarketingDescription(
      descriptionHtml
    );


  if (!description) {
    const headingInfo =
      findFirstStructuredHeadingLine(
        sectionText
      );


    if (headingInfo.index > 0) {
      description =
        headingInfo.lines
          .slice(
            0,
            headingInfo.index
          )
          .join(' ');


      description =
        cleanMarketingDescription(
          description
        );
    }
  }


  if (description) {
    result.description_clean =
      description;
  }


  /* ----------------------------------------------------------
     5. Product attributes
  ---------------------------------------------------------- */

  if (attributes.length) {
    result.product_attributes =
      attributes;
  }


  /* ----------------------------------------------------------
     6. NEW — Ingredient Highlights
  ---------------------------------------------------------- */

  if (
    result.ingredients ||
    result.other_ingredients
  ) {
    const ingredientHighlights =
      extractIngredientHighlights(
        result.ingredients || '',
        result.other_ingredients || ''
      );


    if (ingredientHighlights.length) {
      result.ingredient_highlights =
        ingredientHighlights;
    }
  }


  return result;
}


/* ============================================================
   SHOPIFY METAFIELD VALUE SERIALIZATION
============================================================ */

export function toMetafieldValue(key, value) {

  /*
    Shopify list metafield.
  */
  if (key === 'product_attributes') {
    return JSON.stringify(
      Array.isArray(value)
        ? value
        : []
    );
  }


  /*
    Stage 1 structured ingredient JSON.
  */
  if (key === 'ingredient_highlights' || key === 'serving_derivation') {
    return JSON.stringify(
      Array.isArray(value)
        ? value
        : []
    );
  }


  return String(value ?? '').trim();
}