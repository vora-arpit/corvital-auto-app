import { GoogleGenAI } from '@google/genai';
import { put } from '@vercel/blob';

const MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';

function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is missing.');
  }
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function slugify(value) {
  return String(value || 'product')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function detectMimeType(contentType, imageUrl) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return 'image/png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'image/jpeg';
  if (type.includes('webp')) return 'image/webp';

  const url = String(imageUrl || '').toLowerCase();
  if (/\.png(?:\?|$)/.test(url)) return 'image/png';
  if (/\.jpe?g(?:\?|$)/.test(url)) return 'image/jpeg';
  if (/\.webp(?:\?|$)/.test(url)) return 'image/webp';
  return 'image/png';
}

async function downloadReferenceImage(imageUrl) {
  if (!imageUrl) throw new Error('No reference image URL supplied.');

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(
      `Unable to download reference image: ${response.status} ${response.statusText}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Reference image download returned an empty file.');

  return {
    buffer,
    mimeType: detectMimeType(response.headers.get('content-type'), imageUrl),
  };
}

function buildPrompt(productTitle) {
  return `
Use the supplied product image as the ONLY visual reference for the physical capsule shown in the image.

Product: ${productTitle}

Create a clean, premium studio product asset showing ONE opened capsule with a small natural amount of its internal powder spilling from the opening.

ACCURACY REQUIREMENTS:
- Match the real capsule shell color visible in the reference image as closely as possible.
- Match its shell opacity/transparency.
- Match its capsule shape and proportions.
- Match the visible powder/fill color.
- Preserve the real capsule's overall physical appearance.
- Do not invent a different capsule color or design.

REMOVE / IGNORE:
- bottle
- product label
- packaging
- logos
- text
- icons
- instructions
- hands or people
- decorative props
- infographic elements

OUTPUT COMPOSITION:
- one opened capsule as the clear central subject
- small realistic powder spill
- premium supplement studio photography
- centered composition
- soft realistic lighting
- clean neutral white or near-white background
- no text or branding anywhere

This image will later be placed into a separate HTML ingredient infographic. Generate only the capsule visual and powder.
`.trim();
}

function getOutputImage(interaction) {
  if (interaction?.output_image?.data) {
    return {
      data: interaction.output_image.data,
      mimeType: interaction.output_image.mime_type || 'image/png',
    };
  }

  for (const step of interaction?.steps || []) {
    if (step?.type !== 'model_output') continue;
    for (const block of step?.content || []) {
      if (block?.type === 'image' && block?.data) {
        return {
          data: block.data,
          mimeType: block.mime_type || 'image/png',
        };
      }
    }
  }

  return null;
}

export async function generateCapsuleDraft({
  productId,
  productTitle,
  referenceImageUrl,
}) {
  if (!referenceImageUrl) {
    throw new Error(`No capsule reference image available for ${productTitle}.`);
  }

  console.log(`[capsule-ai] Starting generation for ${productTitle}`);
  console.log(`[capsule-ai] Reference image: ${referenceImageUrl}`);

  const reference = await downloadReferenceImage(referenceImageUrl);
  console.log(
    `[capsule-ai] Reference downloaded: ${Math.round(reference.buffer.length / 1024)} KB (${reference.mimeType})`
  );

  const ai = getGeminiClient();
  const interaction = await ai.interactions.create({
    model: MODEL,
    input: [
      {
        type: 'image',
        mime_type: reference.mimeType,
        data: reference.buffer.toString('base64'),
      },
      {
        type: 'text',
        text: buildPrompt(productTitle),
      },
    ],
  });

  const generated = getOutputImage(interaction);
  if (!generated?.data) {
    throw new Error('Gemini returned no generated image.');
  }

  const generatedBuffer = Buffer.from(generated.data, 'base64');
  if (!generatedBuffer.length) {
    throw new Error('Gemini returned an empty generated image.');
  }

  console.log(
    `[capsule-ai] Generated image: ${Math.round(generatedBuffer.length / 1024)} KB`
  );

  const numericProductId = String(productId || '').split('/').pop();
  const fileName = `capsule-drafts/${slugify(productTitle)}-${numericProductId}-${Date.now()}.png`;

  // On new Vercel Blob project connections, the latest @vercel/blob can
  // authenticate automatically through Vercel OIDC.
  const blob = await put(fileName, generatedBuffer, {
    access: 'public',
    contentType: generated.mimeType || 'image/png',
    addRandomSuffix: false,
  });

  console.log(`[capsule-ai] Stored draft: ${blob.url}`);

  return {
    url: blob.url,
    pathname: blob.pathname,
    referenceImageUrl,
    generatedAt: new Date().toISOString(),
    model: MODEL,
  };
}
