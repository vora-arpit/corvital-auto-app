import * as cheerio from 'cheerio';

/* ============================================================
   CORVITAL PLUS — SUPLIFUL DESCRIPTION PARSER
   ------------------------------------------------------------
   Goals:
   - Preserve real marketing paragraphs
   - Ignore cosmetic <br> line breaks inside paragraphs
   - Parse Supliful labeled fields
   - Extract product attributes / certifications
   - Normalize product amount + weight formatting
   - Preserve source ingredient values
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

  suggested_use: 'multi_line_text_field',
  caution: 'multi_line_text_field',
  iron_warning: 'multi_line_text_field',
  warning: 'multi_line_text_field',
  storage: 'multi_line_text_field',

  fda_disclaimer: 'multi_line_text_field',

  product_attributes: 'list.single_line_text_field'
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


/*
   IMPORTANT:

   This function preserves REAL paragraphs.

   <br> is treated as a SPACE.
   </p> / block elements create paragraph separation.

   This prevents:

   "Your hair, skin, and nails...
    Hair, Skin & Nails Essentials...
    are formulated..."

   and produces:

   "Your hair, skin, and nails... Hair, Skin & Nails Essentials
    Capsules are formulated..."

   while preserving actual paragraph boundaries.
*/

function htmlToParagraphText(html) {
  const $ = cheerio.load(html || '', null, false);

  /* Images don't belong in clean description text. */
  $('img').remove();

  /*
    Cosmetic line breaks inside paragraphs should NOT
    become paragraph breaks.
  */
  $('br').replaceWith(' ');

  /*
    Add explicit paragraph separators after genuine
    block-level content.

    Two newlines are intentional.
  */
  $('p,div,h1,h2,h3,h4,h5,h6,blockquote').each((_, el) => {
    $(el).append('\n\n');
  });

  /*
    List items remain individual lines.
  */
  $('li').each((_, el) => {
    $(el).append('\n');
  });

  let text = $.root().text();

  text = text
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')

    /* Normalize spaces without touching newlines. */
    .replace(/[ \t]+/g, ' ')

    /* Remove spaces surrounding newline boundaries. */
    .replace(/ *\n */g, '\n')

    /* 3+ newlines = one paragraph break. */
    .replace(/\n{3,}/g, '\n\n')

    .trim();

  return text;
}


/*
   This version is intentionally used for parsing
   labeled Supliful fields.

   Unlike the marketing-description parser above,
   labels need to be placed on separate lines so
   detectHeading() can recognize them.
*/

function htmlToSectionText(html) {
  const $ = cheerio.load(html || '', null, false);

  /*
    Put bold Supliful labels on their own logical lines.

    Example:

    <strong>Ingredients:</strong> Magnesium...

    becomes approximately:

    Ingredients:
    Magnesium...
  */
  $('strong,b').each((_, el) => {
    $(el).before('\n').after('\n');
  });

  /*
    For structured parsing, BR tags are useful boundaries.
  */
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


  /* Image metadata */
  $('img').each((_, el) => {
    add($(el).attr('alt'));
    add($(el).attr('title'));
    add($(el).attr('aria-label'));
  });


  /* Linked badges / icons */
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


  /*
    Whitelist fallback.

    This handles descriptions where Shopify/Supliful
    flattens badge labels into unusual HTML.
  */
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

    /* Remove heading residue such as "(oz/lb/g):" */
    .replace(
      /^\s*\(\s*oz\s*\/\s*lbs?\s*\/\s*g\s*\)\s*:\s*/i,
      ''
    )

    .replace(
      /^\s*oz\s*\/\s*lbs?\s*\/\s*g\s*:\s*/i,
      ''
    )

    /*
      Normalize:
      1.3oz  -> 1.3 oz
      0.25lb -> 0.25 lb
      177ml  -> 177 ml

      This is intentionally NOT applied to ingredients.
    */
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


  /*
    Product amount and gross weight can safely have
    unit spacing normalized.

    Ingredients remain untouched.
  */
  if (
    key === 'product_amount' ||
    key === 'gross_weight'
  ) {
    v = normalizeUnits(v);
  }


  /*
    Clean FDA disclaimer punctuation.
  */
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


  /*
    Structured fields should not contain accidental
    formatting newlines.

    Multi-line fields can preserve intentional paragraphs,
    but random single newlines are converted to spaces.
  */
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


  /* ----------------------------------------------------------
     FDA disclaimer
  ---------------------------------------------------------- */

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


  /* ----------------------------------------------------------
     Normal structured headings
  ---------------------------------------------------------- */

  for (const def of SECTION_DEFS) {
    for (const alias of def.aliases) {
      const escaped = escapeRegex(alias);


      /*
        Supports:

        Product amount: 60 capsules

        Product amount (oz/lb/g):
        60 capsules...

        Gross weight (oz/lb/g): 2.4 oz...
      */
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


      /*
        Supports headings flattened onto their own line:

        Ingredients

        Amount

        Warning
      */
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
   FIND WHERE STRUCTURED SUPLIFUL DATA BEGINS
============================================================ */

/*
   We use the section-parser representation only to determine
   where the marketing description ends.

   This prevents Ingredients, Manufacturer Country, etc.
   from leaking into description_clean.
*/

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


  /*
    Normalize spaces inside paragraphs.
  */
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


  /*
    Remove trailing Supliful structure asterisk.
  */
  text = text
    .replace(/\*+\s*$/, '')
    .trim();


  return text;
}


/* ============================================================
   EXTRACT CLEAN MARKETING DESCRIPTION FROM ORIGINAL HTML
============================================================ */

function extractMarketingDescription(descriptionHtml) {
  const $ = cheerio.load(
    descriptionHtml || '',
    null,
    false
  );


  /*
    Remove attribute badges/images before processing.
  */
  $('img').remove();


  /*
    Find the first element containing a recognized structured
    heading such as Ingredients, Manufacturer Country, etc.

    Everything from this element onward belongs to the
    structured Supliful section rather than marketing copy.
  */
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


  /*
    If the label wasn't isolated inside <strong>, check
    block elements too.
  */
  if (!firstStructuredNode) {
    $('p,div,li,h1,h2,h3,h4,h5,h6').each((_, el) => {
      if (firstStructuredNode) return;

      const text = $(el)
        .text()
        .replace(/\u00a0/g, ' ')
        .trim();

      /*
        Only inspect the beginning of the block so an entire
        parent DIV containing the whole description doesn't
        get falsely selected.
      */
      const firstPart = text.slice(0, 200);

      if (detectHeading(firstPart)) {
        firstStructuredNode = el;
      }
    });
  }


  /*
    Remove structured content from the marketing-copy clone.
  */
  if (firstStructuredNode) {
    let node = $(firstStructuredNode);

    /*
      Prefer the nearest paragraph/block containing the label.
    */
    const block = node.closest(
      'p,li,h1,h2,h3,h4,h5,h6'
    );

    if (block.length) {
      node = block;
    }


    /*
      Remove this node and all following siblings at its level.
    */
    node.nextAll().remove();
    node.remove();
  }


  const remainingHtml = $.root().html() || '';

  return cleanMarketingDescription(
    htmlToParagraphText(remainingHtml)
  );
}


/* ============================================================
   MAIN PARSER
============================================================ */

export function parseSuplifulDescription(descriptionHtml) {

  /* ----------------------------------------------------------
     1. Extract attributes from ORIGINAL HTML
  ---------------------------------------------------------- */

  const attributes =
    extractAttributes(descriptionHtml);


  /* ----------------------------------------------------------
     2. Build section-friendly text
  ---------------------------------------------------------- */

  const sectionText =
    htmlToSectionText(descriptionHtml);


  const lines = sectionText
    .split(/\n+/)
    .map((value) => value.trim())
    .filter(Boolean);


  const result = {};

  let current = null;
  let bucket = [];


  /* ----------------------------------------------------------
     Flush currently collected structured section
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
      cleanValue(current.key, combined);

    if (cleaned) {
      result[current.key] = cleaned;
    }

    current = null;
    bucket = [];
  };


  /* ----------------------------------------------------------
     3. Parse structured sections
  ---------------------------------------------------------- */

  for (const line of lines) {
    const heading =
      detectHeading(line);

    if (heading) {
      flush();

      current = heading;
      continue;
    }


    /*
      Ignore marketing-copy lines here.

      Marketing description is extracted separately from
      original HTML below so its paragraph structure survives.
    */
    if (current) {
      bucket.push(line);
    }
  }


  flush();


  /* ----------------------------------------------------------
     4. Extract marketing description independently
  ---------------------------------------------------------- */

  let description =
    extractMarketingDescription(
      descriptionHtml
    );


  /*
    Fallback for unusual Supliful HTML where DOM-based
    extraction could not isolate the marketing section.
  */
  if (!description) {
    const headingInfo =
      findFirstStructuredHeadingLine(sectionText);

    if (headingInfo.index > 0) {
      description = headingInfo.lines
        .slice(0, headingInfo.index)
        .join(' ');

      description =
        cleanMarketingDescription(description);
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


  return result;
}


/* ============================================================
   SHOPIFY METAFIELD VALUE SERIALIZATION
============================================================ */

export function toMetafieldValue(key, value) {

  /*
    Shopify list metafields expect JSON arrays.
  */
  if (key === 'product_attributes') {
    return JSON.stringify(
      Array.isArray(value)
        ? value
        : []
    );
  }


  return String(value ?? '').trim();
}