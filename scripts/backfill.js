import { listAllProducts, syncProduct } from '../src/sync-product.js';

const products = await listAllProducts();
console.log(`[backfill] Found ${products.length} products.`);

let ok = 0;
let failed = 0;
for (const product of products) {
  try {
    const result = await syncProduct(product.id);
    console.log(`[backfill] ${product.title}: ${result.status}, updated=${result.updated}`);
    ok++;
  } catch (error) {
    failed++;
    console.error(`[backfill] ${product.title}: FAILED`, error);
  }
}

console.log(`[backfill] Done. OK=${ok} Failed=${failed}`);
if (failed) process.exitCode = 1;
