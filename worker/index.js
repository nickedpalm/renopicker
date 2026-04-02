// Cloudflare Worker: Appliance page scraper + Perplexity blurb generator
// Deploy to Cloudflare Workers — PPLX_KEY set via wrangler secret

export default {
  async fetch(request, env) {
    const PPLX_KEY = env.PPLX_KEY;
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers: cors });

    try {
      const body = await request.json();

      if (body.action === 'blurb') {
        const result = await generateStructuredReview(PPLX_KEY, body.name, body.price, body.dim, body.notes);
        return Response.json({ success: true, ...result }, { headers: cors });
      }

      const url = body.url;
      if (!url) return Response.json({ error: 'url required' }, { status: 400, headers: cors });

      // Use Perplexity to extract product data, then try to get a working image
      const data = await extractProductFromUrl(PPLX_KEY, url);

      // Try to verify the Perplexity image works, fall back to og:image from direct fetch
      let image = data.image;
      if (image) {
        try {
          const imgResp = await fetch(image, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
          if (!imgResp.ok) image = null;
        } catch { image = null; }
      }
      if (!image) {
        image = await extractOgImage(url);
      }
      data.image = image;

      return Response.json({ success: true, data: { ...data, url } }, { headers: cors });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: cors });
    }
  }
};

async function extractOgImage(url) {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      redirect: 'follow',
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    const baseUrl = new URL(url);

    // Try og:image
    const ogImg = html.match(/property="og:image"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+property="og:image"/i);
    if (ogImg?.[1]) {
      try { return new URL(ogImg[1], baseUrl).href; } catch {}
    }

    // Try JSON-LD
    const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (ldMatch) {
      for (const block of ldMatch) {
        try {
          const j = JSON.parse(block.replace(/<\/?script[^>]*>/gi, ''));
          const img = j.image || j?.offers?.image;
          if (img) {
            const imgUrl = Array.isArray(img) ? img[0] : (typeof img === 'object' ? img.url : img);
            if (imgUrl) { try { return new URL(imgUrl, baseUrl).href; } catch {} }
          }
        } catch {}
      }
    }

    // Try twitter:image
    const twImg = html.match(/name="twitter:image"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+name="twitter:image"/i);
    if (twImg?.[1]) {
      try { return new URL(twImg[1], baseUrl).href; } catch {}
    }

    return null;
  } catch { return null; }
}

async function extractProductFromUrl(apiKey, url) {
  const sysMsg = `You are a product data extractor. Given a product URL, find and return structured JSON about the product. You MUST respond with ONLY valid JSON, no other text.

Return this exact JSON structure:
{
  "name": "product name (max 80 chars)",
  "dim": "dimensions like 29.75\\"W x 69\\"H x 27\\"D",
  "notes": "any notable features or caveats",
  "price": 0,
  "image": "direct URL to a product image (must be a real image URL ending in .jpg/.png/.webp or from a CDN)",
  "blurb": "2-3 sentence review for a Brooklyn apartment renovation (Clinton Hill Coops, 1940s co-op). Focus on fit for compact NYC kitchen, real review insights, energy efficiency, value. Under 60 words.",
  "pros": ["pro 1", "pro 2", "pro 3"],
  "cons": ["con 1", "con 2"],
  "rating": 7,
  "features": ["feature 1", "feature 2", "feature 3"]
}

For price, use the numeric value (no $ sign). For rating, use 1-10 scale. For image, find the actual product image URL from the page.`;

  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content: 'Extract product data from: ' + url }
      ],
      max_tokens: 800
    }),
  });

  if (!resp.ok) throw new Error('Perplexity error ' + resp.status);
  const result = await resp.json();
  const text = result.choices?.[0]?.message?.content || '';
  const citations = result.citations || [];

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[0]);
      return {
        name: (data.name || 'Unknown Product').slice(0, 80),
        dim: data.dim || '',
        notes: data.notes || '',
        price: typeof data.price === 'number' ? data.price : parseFloat(data.price) || 0,
        image: data.image || null,
        blurb: data.blurb || '',
        citations,
        pros: Array.isArray(data.pros) ? data.pros : [],
        cons: Array.isArray(data.cons) ? data.cons : [],
        rating: typeof data.rating === 'number' ? data.rating : parseInt(data.rating) || 0,
        features: Array.isArray(data.features) ? data.features : [],
      };
    }
  } catch {}

  // Fallback: use raw text as blurb
  return { name: 'Unknown Product', dim: '', notes: '', price: 0, image: null, blurb: text, citations, pros: [], cons: [], rating: 0, features: [] };
}

async function generateStructuredReview(apiKey, name, price, dim, notes) {
  const sysMsg = `You help a couple renovating a pre-war Brooklyn apartment in the Clinton Hill Coops (a 1940s co-op complex). Return ONLY valid JSON with this structure:
{
  "blurb": "2-3 sentence review. Focus on fit for compact NYC kitchen, real review insights, energy efficiency, value. Under 60 words. Conversational, not salesy.",
  "pros": ["pro 1", "pro 2", "pro 3"],
  "cons": ["con 1", "con 2"],
  "rating": 7,
  "features": ["feature 1", "feature 2"]
}
Rating is 1-10. No text outside the JSON.`;

  const userMsg = 'Product: ' + name + (price ? ' ($' + price + ')' : '') + (dim ? ' | Dimensions: ' + dim : '') + (notes ? ' | Notes: ' + notes : '');

  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }],
      max_tokens: 400
    }),
  });

  if (!resp.ok) return { blurb: 'Perplexity error ' + resp.status, citations: [], pros: [], cons: [], rating: 0, features: [] };
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        blurb: parsed.blurb || text,
        citations,
        pros: Array.isArray(parsed.pros) ? parsed.pros : [],
        cons: Array.isArray(parsed.cons) ? parsed.cons : [],
        rating: typeof parsed.rating === 'number' ? parsed.rating : parseInt(parsed.rating) || 0,
        features: Array.isArray(parsed.features) ? parsed.features : [],
      };
    }
  } catch {}

  return { blurb: text, citations, pros: [], cons: [], rating: 0, features: [] };
}
