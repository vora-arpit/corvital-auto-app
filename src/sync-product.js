import { shopifyGraphQL } from './shopify.js';
import { METAFIELD_TYPES, parseSuplifulDescription, toMetafieldValue } from './parser.js';
import { generateCapsuleDraft } from './capsule-generator.js';

const CAPSULE_SOURCE_KEY = 'capsule_source_candidate';
const CAPSULE_SOURCE_TYPE = 'json';
const PREFERRED_CAPSULE_IMAGE_POSITION = 4;

const PRODUCT_QUERY = `#graphql
  query CorVitalProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml

      media(first: 20, query: "media_type:IMAGE", sortKey: POSITION) {
        nodes {
          id
          alt
          mediaContentType
          status
          ... on MediaImage {
            image {
              url
              width
              height
              altText
            }
          }
        }
      }

      metafields(first: 100, namespace: "custom") {
        nodes {
          key
          type
          value
        }
      }
    }
  }
`;

const SET_METAFIELDS = `#graphql
  mutation CorVitalMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        key
        type
        value
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

function selectCapsuleSourceCandidate(mediaNodes = []) {
  const images = (mediaNodes || []).filter((node) => {
    return (
      node &&
      node.mediaContentType === 'IMAGE' &&
      node.status === 'READY' &&
      node.image?.url
    );
  });

  if (!images.length) {
    return null;
  }

  // Stage 2 rule:
  // Prefer the fourth IMAGE because that is where your current
  // Supliful catalog normally shows the capsule reference photo.
  // If there are fewer than 4 images, fall back to the last
  // available image instead of failing.
  const preferredIndex = PREFERRED_CAPSULE_IMAGE_POSITION - 1;
  const selected = images[preferredIndex] || images[images.length - 1];
  const actualIndex = images.findIndex((item) => item.id === selected.id);

  return {
    media_id: selected.id,
    position: actualIndex + 1,
    preferred_position: PREFERRED_CAPSULE_IMAGE_POSITION,
    selection_method:
      actualIndex === preferredIndex
        ? 'preferred_position_4'
        : 'fallback_last_available_image',
    url: selected.image.url,
    alt: selected.alt || selected.image.altText || '',
    width: Number(selected.image.width || 0),
    height: Number(selected.image.height || 0),
    status: selected.status,
  };
}

function stableJson(value) {
  return JSON.stringify(value);
}

function queueMetafieldIfChanged({
  inputs,
  existing,
  ownerId,
  key,
  type,
  value,
}) {
  if (value === undefined || value === null || value === '') {
    return false;
  }

  const old = existing.get(key);

  if (
    old &&
    old.type === type &&
    old.value === value
  ) {
    return false;
  }

  inputs.push({
    ownerId,
    namespace: 'custom',
    key,
    type,
    value,
  });

  return true;
}

export async function syncProduct(productGid) {
  const data = await shopifyGraphQL(PRODUCT_QUERY, {
    id: productGid,
  });

  const product = data.product;

  if (!product) {
    console.warn(`[sync] Product not found: ${productGid}`);
    return {
      status: 'not_found',
      updated: 0,
    };
  }

  /* =========================================================
     STAGE 1 — DESCRIPTION + INGREDIENT DATA
  ========================================================= */

  const parsed = parseSuplifulDescription(
    product.descriptionHtml || ''
  );

  const existing = new Map(
    (product.metafields?.nodes || []).map((metafield) => [
      metafield.key,
      metafield,
    ])
  );

  const inputs = [];

  for (const [key, rawValue] of Object.entries(parsed)) {
    const type = METAFIELD_TYPES[key];

    if (!type) continue;

    const value = toMetafieldValue(key, rawValue);

    if (!value) continue;

    queueMetafieldIfChanged({
      inputs,
      existing,
      ownerId: product.id,
      key,
      type,
      value,
    });
  }

  /* =========================================================
     STAGE 2 — CAPSULE SOURCE IMAGE CANDIDATE
  ========================================================= */

  const capsuleCandidate = selectCapsuleSourceCandidate(
    product.media?.nodes || []
  );

  if (capsuleCandidate) {
    console.log(
      `[capsule-source] ${product.title}: ` +
      `selected image #${capsuleCandidate.position} ` +
      `(${capsuleCandidate.selection_method})`
    );

    console.log(
      `[capsule-source] ${product.title}: ` +
      `${capsuleCandidate.width}x${capsuleCandidate.height} ` +
      `${capsuleCandidate.url}`
    );

    queueMetafieldIfChanged({
      inputs,
      existing,
      ownerId: product.id,
      key: CAPSULE_SOURCE_KEY,
      type: CAPSULE_SOURCE_TYPE,
      value: stableJson(capsuleCandidate),
    });
  } else {
    console.warn(
      `[capsule-source] ${product.title}: no READY product image found.`
    );
  }

  /* =========================================================
     NOTHING TO UPDATE
  ========================================================= */

  if (!inputs.length) {
    console.log(`[sync] ${product.title}: already up to date.`);

    return {
      status: 'unchanged',
      updated: 0,
      parsedKeys: Object.keys(parsed),
      capsuleCandidate,
    };
  }

  /* =========================================================
     WRITE CHANGED METAFIELDS
  ========================================================= */

  const mutationData = await shopifyGraphQL(
    SET_METAFIELDS,
    {
      metafields: inputs,
    }
  );

  const result = mutationData.metafieldsSet;

  if (result.userErrors?.length) {
    throw new Error(
      `metafieldsSet errors for ${product.title}: ` +
      JSON.stringify(result.userErrors)
    );
  }

  console.log(
    `[sync] ${product.title}: updated ` +
    `${result.metafields.length} metafield(s): ` +
    inputs.map((item) => item.key).join(', ')
  );

  return {
    status: 'updated',
    updated: result.metafields.length,
    parsedKeys: Object.keys(parsed),
    capsuleCandidate,
  };
}

export async function listAllProducts() {
  const query = `#graphql
    query CorVitalProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        nodes {
          id
          title
          handle
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const products = [];
  let after = null;

  do {
    const data = await shopifyGraphQL(query, {
      first: 100,
      after,
    });

    products.push(...data.products.nodes);

    after = data.products.pageInfo.hasNextPage
      ? data.products.pageInfo.endCursor
      : null;
  } while (after);

  return products;
}

export async function generateProductCapsuleDraft(
  productGid
) {

  const query = `
    query CapsuleProduct($id: ID!) {
      product(id: $id) {
        id
        title

        metafield(
          namespace: "custom"
          key: "capsule_source_candidate"
        ) {
          value
        }
      }
    }
  `;


  const data =
    await shopifyGraphQL(
      query,
      {
        id:
          productGid
      }
    );


  const product =
    data?.product;


  if (!product) {
    throw new Error(
      `Product not found: ${productGid}`
    );
  }


  const candidateRaw =
    product
      ?.metafield
      ?.value;


  if (!candidateRaw) {
    throw new Error(
      `No capsule_source_candidate found for ${product.title}`
    );
  }


  let candidate;


  try {
    candidate =
      JSON.parse(
        candidateRaw
      );
  } catch {
    throw new Error(
      `Invalid capsule_source_candidate JSON for ${product.title}`
    );
  }


  if (!candidate?.url) {
    throw new Error(
      `Capsule source candidate has no URL for ${product.title}`
    );
  }


  console.log(
    `[capsule-ai] Creating draft for ${product.title}`
  );


  /* ----------------------------------------------------------
     Generate AI capsule
  ---------------------------------------------------------- */

  const generated =
    await generateCapsuleDraft({
      productId:
        product.id,

      productTitle:
        product.title,

      referenceImageUrl:
        candidate.url
    });


  /* ----------------------------------------------------------
     Save resulting URL to Shopify
  ---------------------------------------------------------- */

  const mutation = `
    mutation SetCapsuleDraft(
      $metafields: [MetafieldsSetInput!]!
    ) {
      metafieldsSet(
        metafields: $metafields
      ) {
        metafields {
          namespace
          key
          value
        }

        userErrors {
          field
          message
          code
        }
      }
    }
  `;


  const mutationData =
    await shopifyGraphQL(
      mutation,
      {
        metafields: [
          {
            ownerId:
              product.id,

            namespace:
              'custom',

            key:
              'capsule_generated_draft',

            type:
              'url',

            value:
              generated.url
          },

          {
            ownerId:
              product.id,

            namespace:
              'custom',

            key:
              'capsule_visual_status',

            type:
              'single_line_text_field',

            value:
              'draft'
          }
        ]
      }
    );


  const userErrors =
    mutationData
      ?.metafieldsSet
      ?.userErrors || [];


  if (userErrors.length) {
    throw new Error(
      userErrors
        .map(
          (error) =>
            `${error.field || ''}: ${error.message}`
        )
        .join('; ')
    );
  }


  console.log(
    `[capsule-ai] ${product.title}: draft URL written to Shopify`
  );


  return {
    product:
      product.title,

    status:
      'draft',

    image:
      generated.url,

    reference:
      candidate.url
  };
}
