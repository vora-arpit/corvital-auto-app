import 'dotenv/config';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  shop: required('SHOPIFY_SHOP').replace(/^https?:\/\//, '').replace(/\/$/, ''),
  clientId: required('SHOPIFY_CLIENT_ID'),
  clientSecret: required('SHOPIFY_CLIENT_SECRET'),
  apiVersion: process.env.SHOPIFY_API_VERSION?.trim() || '2026-07',
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim().replace(/\/$/, '') || '',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY?.trim() || '',
  claudeModel: process.env.CLAUDE_MODEL?.trim() || 'claude-haiku-4-5-20251001',
  port: Number(process.env.PORT || 3000),
};

if (!config.shop.endsWith('.myshopify.com')) {
  config.shop = `${config.shop}.myshopify.com`;
}
