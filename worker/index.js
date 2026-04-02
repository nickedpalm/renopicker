// Cloudflare Worker: Appliance page scraper + Perplexity blurb generator
// Deploy to Cloudflare Workers and set your PERPLEXITY_API_KEY below

const PPLX_KEY = 'YOUR_PERPLEXITY_KEY_HERE';

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'POST') return Response.json({ error: 'POST required' }, { status: 405, headers: cors });

    try {
      const body = await request.json();

      if (body.action === 'blurb') {
        const blurb = await generateBlurb(body.name, body.price, body.dim, body.notes);
        return Response.json({ success: true, blurb }, { headers: cors });
      }

      const url = body.url;
      if (!url) return Response.json({ error: 'url required' }, { status: 400, headers: cors });

      const pageResp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow',
      });
      if (!pageResp.ok) return Response.json({ error: 'Failed to fetch: ' + pageResp.status }, { status: 502, headers: cors });

      const html = await pageResp.text();
      const baseUrl = new URL(url);

      // Extract image (og:image > JSON-LD > product img tag)
      const ogImg = html.match(/property="og:image"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+property="og:image"/i);
      let ldImage = null;
      const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
      if (ldMatch) {
        for (const block of ldMatch) {
          try {
            const j = JSON.parse(block.replace(/<\/?script[^>]*>/gi, ''));
            const img = j.image || j?.offers?.image;
            if (img) { ldImage = Array.isArray(img) ? img[0] : (typeof img === 'object' ? img.url : img); break; }
          } catch {}
        }
      }
      const imgTags = [...html.matchAll(/<img[^>]+src="([^"]+)"[^>]*/gi)];
      let productImg = null;
      for (const m of imgTags) {
        if (/product|hero|main|primary|feature|gallery/i.test(m[0]) && !/icon|logo|badge|thumbnail|tiny|1x1/i.test(m[0])) {
          productImg = m[1]; break;
        }
      }
      function resolve(u) { if (!u) return null; try { return new URL(u, baseUrl).href; } catch { return null; } }
      const image = resolve(ogImg?.[1]) || resolve(ldImage) || resolve(productImg) || null;

      // Extract text content
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#\d+;/gi, '')
        .replace(/\s+/g, ' ').trim();

      // Extract title
      const ogTitle = html.match(/property="og:title"\s+content="([^"]+)"/i) || html.match(/content="([^"]+)"\s+property="og:title"/i);
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
      const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const rawTitle = (ogTitle?.[1] || h1?.[1] || titleTag?.[1] || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

      // Extract price
      let prices = [];
      const pp = /\$\s?([\d,]+(?:\.\d{2})?)/g;
      let pm;
      while ((pm = pp.exec(text)) !== null) {
        const p = parseFloat(pm[1].replace(/,/g, ''));
        if (p > 50 && p < 50000) prices.push(p);
      }

      // Extract dimensions
      const dp = [
        /(\d+[\d./\s]*)"?\s*[Ww]\s*[x\u00d7]\s*(\d+[\d./\s]*)"?\s*[Hh]\s*[x\u00d7]\s*(\d+[\d./\s]*)"?\s*[Dd]/g,
        /(?:width|w)[:\s]*(\d+[\d./\s]*)"?.*?(?:height|h)[:\s]*(\d+[\d./\s]*)"?.*?(?:depth|d)[:\s]*(\d+[\d./\s]*)"?/gi
      ];
      let dim = '';
      for (const pat of dp) {
        const m = pat.exec(text);
        if (m) { dim = m[1].trim() + '"W x ' + m[2].trim() + '"H x ' + m[3].trim() + '"D'; break; }
      }

      const name = rawTitle.slice(0, 80) || 'Unknown Product';
      const price = prices.length ? prices[0] : 0;
      const blurb = await generateBlurb(name, price, dim, '');

      return Response.json({ success: true, data: { name, dim, notes: '', price, url, image, blurb } }, { headers: cors });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: cors });
    }
  }
};

async function generateBlurb(name, price, dim, notes) {
  const sysMsg = 'You help a couple renovating a pre-war Brooklyn apartment in the Clinton Hill Coops (a 1940s co-op complex). Write a 2-3 sentence blurb about the given appliance. Focus on: how it fits a compact NYC kitchen, any pros/cons from real reviews, energy efficiency, and value for money. Be conversational and helpful, not salesy. Mention any known issues. Keep it under 60 words.';
  const userMsg = 'Appliance: ' + name + (price ? ' ($' + price + ')' : '') + (dim ? ' | Dimensions: ' + dim : '') + (notes ? ' | Notes: ' + notes : '');

  try {
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + PPLX_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }],
        max_tokens: 150
      }),
    });
    if (!resp.ok) return 'Perplexity error ' + resp.status;
    const data = await resp.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  } catch (e) { return 'Error: ' + e.message; }
}
