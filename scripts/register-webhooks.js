import { config } from '../src/config.js';
import { shopifyGraphQL } from '../src/shopify.js';

if (!config.publicBaseUrl) {
  throw new Error('PUBLIC_BASE_URL is required before registering webhooks.');
}

const uri = `${config.publicBaseUrl}/webhooks/products`;

const listQuery = `#graphql
  query ExistingWebhooks {
    webhookSubscriptions(first: 100) {
      nodes { id topic uri }
    }
  }
`;

const createMutation = `#graphql
  mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

const topics = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE'];
const existing = (await shopifyGraphQL(listQuery)).webhookSubscriptions.nodes;

for (const topic of topics) {
  const found = existing.find(w => w.topic === topic && w.uri === uri);
  if (found) {
    console.log(`[webhook] Already registered: ${topic} -> ${uri}`);
    continue;
  }

  const data = await shopifyGraphQL(createMutation, {
    topic,
    webhookSubscription: { uri },
  });
  const result = data.webhookSubscriptionCreate;
  if (result.userErrors?.length) {
    console.error(`[webhook] Could not register ${topic}:`, result.userErrors);
    process.exitCode = 1;
  } else {
    console.log(`[webhook] Registered ${result.webhookSubscription.topic} -> ${result.webhookSubscription.uri}`);
  }
}
