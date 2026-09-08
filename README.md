# CorVital+ automatic Supliful -> Shopify metafield updater

This is the permanent/server version of the PowerShell parser you tested.

## What it automates

When Shopify sends `products/create` or `products/update`:

1. Verifies the Shopify webhook HMAC.
2. Gets/caches a Shopify Admin API access token using Client ID + Client Secret.
3. Refreshes the token automatically 5 minutes before expiry.
4. If Shopify unexpectedly returns 401, refreshes the token and retries once.
5. Fetches the product `descriptionHtml`.
6. Parses Supliful fields and attributes.
7. Compares them with existing `custom.*` metafields.
8. Writes only changed fields, preventing an endless webhook update loop.

Metafields:
- `custom.description_clean`
- `custom.ingredients`
- `custom.other_ingredients`
- `custom.contains`
- `custom.manufacturer_country`
- `custom.product_amount`
- `custom.gross_weight`
- `custom.serving_size`
- `custom.servings_per_container`
- `custom.suggested_use`
- `custom.caution`
- `custom.iron_warning`
- `custom.warning`
- `custom.storage`
- `custom.fda_disclaimer`
- `custom.product_attributes` (`list.single_line_text_field`)

## 1. Shopify app permissions

Your released/installed app version must have `write_products`. Your current PowerShell output already showed that scope.

## 2. Install locally

Requires Node.js 20+.

```powershell
cd C:\path\to\corvital_auto_app
npm install
Copy-Item .env.example .env
notepad .env
```

Fill `.env` with your store, Client ID, and NEW Client Secret. Do not commit `.env`.

## 3. Local smoke test

```powershell
npm start
```

Open:

`http://localhost:3000/health`

It should return JSON with `"ok": true`.

## 4. Deploy as a persistent HTTPS web service

Deploy this folder to your existing CorVital app backend, Railway, Render, Fly.io, or another persistent Node host.

Set these environment variables on the host:
- `SHOPIFY_SHOP`
- `SHOPIFY_CLIENT_ID`
- `SHOPIFY_CLIENT_SECRET`
- `SHOPIFY_API_VERSION=2026-07`
- `PUBLIC_BASE_URL=https://YOUR-PUBLIC-HOST`
- `PORT` if your host requires it

Do not put secrets in source code.

After deployment, confirm:

`https://YOUR-PUBLIC-HOST/health`

works.

## 5. Register Shopify webhooks

With `PUBLIC_BASE_URL` set to the deployed HTTPS URL:

```powershell
npm run register:webhooks
```

It registers:
- PRODUCTS_CREATE
- PRODUCTS_UPDATE

both pointing to:

`https://YOUR-PUBLIC-HOST/webhooks/products`

## 6. Initial one-time backfill

After deployment and after checking one test product:

```powershell
npm run backfill
```

This syncs all existing products. Future products/updates are handled by webhooks.

## 7. Test the automatic flow

Change one test product description in Shopify/Supliful or create a test product. Watch the service logs. You should see:

`[webhook] PRODUCTS_UPDATE -> gid://shopify/Product/...`

followed by:

`[sync] Product Name: updated N metafield(s)`

If the data already matches:

`[sync] Product Name: already up to date.`

## Important deployment note

The webhook endpoint acknowledges Shopify immediately and then processes on the same persistent Node process. Use a persistent web service, not a platform that freezes/terminates execution immediately after the HTTP response. For higher scale later, put webhook jobs on a queue.
