import { shopifyGraphQL } from './shopify.js';
import { METAFIELD_TYPES, parseSuplifulDescription, toMetafieldValue } from './parser.js';

const PRODUCT_QUERY = `#graphql
  query CorVitalProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      descriptionHtml
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
      metafields { key type value }
      userErrors { field message code }
    }
  }
`;

function queueMetafieldIfChanged({ inputs, existing, ownerId, key, type, value }) {
  if (value === undefined || value === null || value === '') return false;
  const old = existing.get(key);
  if (old && old.type === type && old.value === value) return false;

  inputs.push({ ownerId, namespace: 'custom', key, type, value });
  return true;
}

export async function syncProduct(productGid) {
  const data = await shopifyGraphQL(PRODUCT_QUERY, { id: productGid });
  const product = data.product;

  if (!product) {
    console.warn(`[sync] Product not found: ${productGid}`);
    return { status: 'not_found', updated: 0 };
  }

  const parsed = parseSuplifulDescription(product.descriptionHtml || '');
  const existing = new Map(
    (product.metafields?.nodes || []).map((metafield) => [metafield.key, metafield])
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

  if (!inputs.length) {
    console.log(`[sync] ${product.title}: source metafields already up to date.`);
    return {
      status: 'unchanged',
      updated: 0,
      parsedKeys: Object.keys(parsed),
    };
  }

  const mutationData = await shopifyGraphQL(SET_METAFIELDS, { metafields: inputs });
  const result = mutationData.metafieldsSet;

  if (result.userErrors?.length) {
    throw new Error(
      `metafieldsSet errors for ${product.title}: ${JSON.stringify(result.userErrors)}`
    );
  }

  console.log(
    `[sync] ${product.title}: updated ${result.metafields.length} source metafield(s): ` +
      inputs.map((item) => item.key).join(', ')
  );

  return {
    status: 'updated',
    updated: result.metafields.length,
    parsedKeys: Object.keys(parsed),
  };
}

export async function listAllProducts() {
  const query = `#graphql
    query CorVitalProducts($first: Int!, $after: String) {
      products(first: $first, after: $after) {
        nodes { id title handle }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const products = [];
  let after = null;

  do {
    const data = await shopifyGraphQL(query, { first: 100, after });
    products.push(...data.products.nodes);
    after = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
  } while (after);

  return products;
}
