import { GoogleGenAI } from '@google/genai';
import { put } from '@vercel/blob';

/* ============================================================
   CORVITAL PLUS — CAPSULE AI GENERATOR
   ------------------------------------------------------------
   Input:
   - Real Shopify/Supliful product image
   - Product title

   Output:
   - AI-reconstructed capsule-only PNG
   - Stored in Vercel Blob
============================================================ */


/* ============================================================
   GEMINI CLIENT
============================================================ */

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});


/* ============================================================
   HELPERS
============================================================ */

function slugify(value) {
  return String(value || 'product')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}


function detectMimeType(contentType, imageUrl) {
  const type =
    String(contentType || '')
      .toLowerCase();

  if (type.includes('png')) {
    return 'image/png';
  }

  if (
    type.includes('jpeg') ||
    type.includes('jpg')
  ) {
    return 'image/jpeg';
  }

  if (type.includes('webp')) {
    return 'image/webp';
  }


  const url =
    String(imageUrl || '')
      .toLowerCase();


  if (url.includes('.png')) {
    return 'image/png';
  }

  if (
    url.includes('.jpg') ||
    url.includes('.jpeg')
  ) {
    return 'image/jpeg';
  }

  if (url.includes('.webp')) {
    return 'image/webp';
  }


  return 'image/png';
}


/* ============================================================
   DOWNLOAD REFERENCE IMAGE
============================================================ */

async function downloadReferenceImage(
  imageUrl
) {
  if (!imageUrl) {
    throw new Error(
      'No reference image URL supplied.'
    );
  }


  const response =
    await fetch(imageUrl);


  if (!response.ok) {
    throw new Error(
      `Unable to download reference image: ${response.status} ${response.statusText}`
    );
  }


  const contentType =
    response.headers.get(
      'content-type'
    );


  const arrayBuffer =
    await response.arrayBuffer();


  const buffer =
    Buffer.from(arrayBuffer);


  if (!buffer.length) {
    throw new Error(
      'Reference image download returned an empty file.'
    );
  }


  const mimeType =
    detectMimeType(
      contentType,
      imageUrl
    );


  return {
    buffer,
    mimeType
  };
}


/* ============================================================
   GENERATION PROMPT
============================================================ */

function buildPrompt(productTitle) {
  return `
You are creating a product-detail visual asset for the supplement product "${productTitle}".

Use ONLY the capsules or tablets visible in the supplied reference photograph as the physical visual reference.

Your task is to reconstruct a clean, high-resolution studio image of the SAME capsule appearance.

STRICT REQUIREMENTS:

1. Match the visible capsule shell color as closely as possible.
2. Match the shell opacity or transparency.
3. Match the capsule shape and proportions.
4. Match the visible fill/powder color.
5. Preserve the general physical appearance of the actual capsule shown in the reference.
6. Ignore the product bottle.
7. Ignore all packaging.
8. Ignore all text.
9. Ignore all icons.
10. Ignore instructions or graphic design elements in the source image.
11. Do not reproduce the product label.
12. Do not add branding.
13. Do not add words.
14. Do not add ingredient names.
15. Do not add connector lines.
16. Do not add decorative props.

COMPOSITION:

- Show one opened capsule as the main subject.
- Include a small realistic amount of powder spilling from the opening.
- Premium supplement product photography.
- Soft studio lighting.
- Sharp, realistic capsule edges.
- Centered composition.
- Minimal neutral background.
- No bottle.
- No text.
- No logo.
- No people.

This image will later be placed inside a separate HTML ingredient infographic, so the output should contain ONLY the reconstructed capsule and powder.

Do not invent a different capsule design.
`.trim();
}


/* ============================================================
   EXTRACT GENERATED IMAGE FROM GEMINI RESPONSE
============================================================ */

function extractGeneratedImage(
  interaction
) {
  /*
    The current Gemini Interactions API exposes
    the final generated image as output_image.
  */

  if (
    interaction?.output_image?.data
  ) {
    return {
      data:
        interaction.output_image.data,

      mimeType:
        interaction.output_image.mime_type ||
        'image/png'
    };
  }


  /*
    Defensive fallback:
    inspect model-output steps.
  */

  const steps =
    interaction?.steps || [];


  for (const step of steps) {
    if (
      step?.type !==
      'model_output'
    ) {
      continue;
    }


    for (
      const block of
      step.content || []
    ) {
      if (
        block?.type === 'image' &&
        block?.data
      ) {
        return {
          data:
            block.data,

          mimeType:
            block.mime_type ||
            'image/png'
        };
      }
    }
  }


  return null;
}


/* ============================================================
   MAIN GENERATOR
============================================================ */

export async function generateCapsuleDraft({
  productId,
  productTitle,
  referenceImageUrl
}) {

  /* ----------------------------------------------------------
     Environment checks
  ---------------------------------------------------------- */

  if (
    !process.env.GEMINI_API_KEY
  ) {
    throw new Error(
      'GEMINI_API_KEY is missing.'
    );
  }


  if (!referenceImageUrl) {
    throw new Error(
      `No capsule reference image available for ${productTitle}.`
    );
  }


  console.log(
    `[capsule-ai] Starting generation for ${productTitle}`
  );


  console.log(
    `[capsule-ai] Reference image: ${referenceImageUrl}`
  );


  /* ----------------------------------------------------------
     Download original Shopify image
  ---------------------------------------------------------- */

  const reference =
    await downloadReferenceImage(
      referenceImageUrl
    );


  console.log(
    `[capsule-ai] Reference downloaded: ${Math.round(reference.buffer.length / 1024)} KB`
  );


  /* ----------------------------------------------------------
     Convert to Base64 for Gemini
  ---------------------------------------------------------- */

  const base64Reference =
    reference.buffer.toString(
      'base64'
    );


  /* ----------------------------------------------------------
     Gemini image edit/generation
  ---------------------------------------------------------- */

  const interaction =
    await ai.interactions.create({
      model:
        'gemini-3.1-flash-image',

      input: [
        {
          type: 'image',

          mime_type:
            reference.mimeType,

          data:
            base64Reference
        },

        {
          type: 'text',

          text:
            buildPrompt(
              productTitle
            )
        }
      ],

      response_format: {
        type: 'image',

        aspect_ratio: '1:1',

        image_size: '2K'
      }
    });


  /* ----------------------------------------------------------
     Extract image
  ---------------------------------------------------------- */

  const generated =
    extractGeneratedImage(
      interaction
    );


  if (!generated?.data) {
    throw new Error(
      'Gemini returned no generated image.'
    );
  }


  const generatedBuffer =
    Buffer.from(
      generated.data,
      'base64'
    );


  if (!generatedBuffer.length) {
    throw new Error(
      'Gemini generated image was empty.'
    );
  }


  console.log(
    `[capsule-ai] Generated image: ${Math.round(generatedBuffer.length / 1024)} KB`
  );


  /* ----------------------------------------------------------
     Store in Vercel Blob
  ---------------------------------------------------------- */

  const productSlug =
    slugify(productTitle);


  const numericProductId =
    String(productId || '')
      .split('/')
      .pop();


  const fileName =
    `capsule-drafts/${productSlug}-${numericProductId}-${Date.now()}.png`;


  const blob =
    await put(
      fileName,
      generatedBuffer,
      {
        access: 'public',

        contentType:
          generated.mimeType ||
          'image/png',

        addRandomSuffix:
          false
      }
    );


  console.log(
    `[capsule-ai] Stored draft: ${blob.url}`
  );


  return {
    url:
      blob.url,

    pathname:
      blob.pathname,

    referenceImageUrl,

    generatedAt:
      new Date().toISOString(),

    model:
      'gemini-3.1-flash-image'
  };
}