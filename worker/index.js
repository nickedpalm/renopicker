// Cloudflare Worker: Appliance page scraper + Perplexity blurb generator
// Deploy to Cloudflare Workers - PPLX_KEY set via wrangler secret

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

      const url = normalizeHttpUrl(body.url);
      if (!url) return Response.json({ error: 'valid http(s) url required' }, { status: 400, headers: cors });

      const expectedCategory = typeof body.category === 'string' ? body.category.trim() : '';
      const page = await fetchProductPage(url);
      const evidence = page.html ? extractPageEvidence(page.html, page.finalUrl || url) : emptyEvidence();

      let data = await extractProductFromUrl(PPLX_KEY, url, evidence, expectedCategory);
      data = normalizeProductData(data);

      let image = await findVerifiedImageFromCandidates([...evidence.imageCandidates, data.image]);
      if (!image) image = await extractOgImage(url);
      if (!image) image = await findVerifiedImage(PPLX_KEY, data.name, data.model || '');
      if (!image && data.citations?.length) {
        for (const cite of data.citations.slice(0, 4)) {
          if (sameUrl(cite, url)) continue;
          image = await extractOgImage(cite);
          if (image) break;
        }
      }
      data.image = image;

      const validation = validateProductData(data, { url, expectedCategory, evidence, page });
      data.sourceConfidence = validation.confidence;
      data.sourceMetadata = {
        extraction: 'perplexity-sonar-with-page-evidence',
        pageFetchOk: Boolean(page.html),
        sourceUrl: url,
        finalUrl: page.finalUrl || url,
        expectedCategory: expectedCategory || null,
        imageVerified: Boolean(image),
        evidenceTitle: evidence.title || null,
        evidenceProductNames: evidence.products.map(p => p.name).filter(Boolean).slice(0, 5),
        validatedAt: new Date().toISOString(),
      };
      data.validationErrors = validation.errors;
      data.validationWarnings = validation.warnings;
      data.needsReview = validation.needsReview;

      const severe = validation.errors.filter(e => e.severity === 'error');
      if (severe.length) {
        return Response.json({
          success: false,
          error: 'Import needs review before saving',
          data: { ...data, url },
          validationErrors: validation.errors,
          validationWarnings: validation.warnings,
          sourceConfidence: validation.confidence,
        }, { status: 422, headers: cors });
      }

      return Response.json({
        success: true,
        data: { ...data, url },
        validationWarnings: validation.warnings,
        sourceConfidence: validation.confidence,
        needsReview: validation.needsReview,
      }, { headers: cors });
    } catch (err) {
      return Response.json({ error: err.message }, { status: 500, headers: cors });
    }
  }
};

const TRUSTED_CDN_RE = /images\.thdstatic\.com|m\.media-amazon\.com|pisces\.bbystatic\.com|mobileimages\.lowes\.com|assets\.ajmadison\.com|media\.kohlsimg\.com|c\.shld\.net|embed\.widencdn\.net|media\.designerappliances\.com|images\.samsung\.com|images\.lg\.com|whirlpoolcorp\.com|kitchenaid-h\.assetsadobe\.com|media\.zestyio\.com|scene7\.com|cloudinary\.com|imgix\.net|images\.webfronts\.com|shopify\.com\/.*\/files\/|assets\.wfcdn\.com|secure\.img1-[^/]+\.wfcdn\.com|s3\.img-b\.com/i;
const IMG_PROXY = 'https://spiel.nickpalm.com';

function emptyEvidence() {
  return { title: '', description: '', products: [], imageCandidates: [], priceCandidates: [] };
}

function normalizeHttpUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    if (!['http:', 'https:'].includes(u.protocol)) return null;
    return u.href;
  } catch { return null; }
}

function cleanText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanImageUrl(url) {
  if (!url) return null;
  const clean = String(url).replace(/\\u002F/g, '/').replace(/[",;]+$/, '').trim();
  if (!/^https?:\/\//i.test(clean)) return null;
  if (/\$\{|\{\{|\}\}|\$\(/.test(clean)) return null;
  return clean;
}

function isTrustedImageUrl(url) {
  const clean = cleanImageUrl(url);
  if (!clean) return false;
  return TRUSTED_CDN_RE.test(clean) && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(clean);
}

function sameUrl(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    ua.hash = '';
    ub.hash = '';
    return ua.href === ub.href;
  } catch { return false; }
}

async function fetchProductPage(url) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      redirect: 'follow',
    });
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok || !contentType.includes('text/html')) {
      return { ok: false, status: resp.status, finalUrl: resp.url || url, html: '' };
    }
    return { ok: true, status: resp.status, finalUrl: resp.url || url, html: await resp.text() };
  } catch (err) {
    return { ok: false, status: 0, finalUrl: url, html: '', error: err.message };
  }
}

function extractPageEvidence(html, pageUrl) {
  const baseUrl = new URL(pageUrl);
  const title = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  const description = cleanText(firstMeta(html, ['description', 'og:description', 'twitter:description']));
  const imageCandidates = [];
  const priceCandidates = [];
  const products = [];

  for (const img of [firstMeta(html, ['og:image', 'twitter:image']), ...findImageUrls(html)]) {
    const resolved = resolveMaybeUrl(img, baseUrl);
    if (resolved && !imageCandidates.includes(resolved)) imageCandidates.push(resolved);
  }

  for (const raw of findJsonLdBlocks(html)) {
    for (const obj of flattenJsonLd(raw)) {
      const types = [].concat(obj['@type'] || []).map(t => String(t).toLowerCase());
      if (!types.includes('product')) continue;
      const product = {
        name: cleanText(obj.name),
        description: cleanText(obj.description),
        sku: cleanText(obj.sku || obj.mpn || obj.model),
        brand: cleanText(typeof obj.brand === 'object' ? obj.brand.name : obj.brand),
      };
      const offers = Array.isArray(obj.offers) ? obj.offers[0] : obj.offers;
      if (offers?.price) priceCandidates.push(Number(String(offers.price).replace(/[^0-9.]/g, '')) || 0);
      const images = Array.isArray(obj.image) ? obj.image : [obj.image];
      for (const img of images) {
        const imageUrl = typeof img === 'object' ? img?.url : img;
        const resolved = resolveMaybeUrl(imageUrl, baseUrl);
        if (resolved && !imageCandidates.includes(resolved)) imageCandidates.push(resolved);
      }
      products.push(product);
    }
  }

  for (const m of html.matchAll(/\$\s*([0-9]{2,5}(?:,[0-9]{3})?(?:\.[0-9]{2})?)/g)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (n > 0 && !priceCandidates.includes(n)) priceCandidates.push(n);
  }

  return {
    title,
    description,
    products: products.filter(p => p.name || p.sku),
    imageCandidates: imageCandidates.slice(0, 20),
    priceCandidates: priceCandidates.filter(Boolean).slice(0, 10),
  };
}

function firstMeta(html, keys) {
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i'),
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m?.[1]) return m[1];
    }
  }
  return '';
}

function findImageUrls(html) {
  const urls = [];
  for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>]+)?/gi)) {
    const u = m[0].replace(/\\\//g, '/');
    if (!urls.includes(u)) urls.push(u);
  }
  for (const tag of html.match(/<img[^>]+>/gi) || []) {
    const m = tag.match(/(?:src|data-src|data-original)=["']([^"']+)["']/i);
    if (m?.[1] && !urls.includes(m[1])) urls.push(m[1]);
  }
  return urls;
}

function findJsonLdBlocks(html) {
  const out = [];
  for (const block of html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || []) {
    const raw = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '').trim();
    try { out.push(JSON.parse(raw)); } catch {}
  }
  return out;
}

function flattenJsonLd(value) {
  const out = [];
  const walk = v => {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') {
      out.push(v);
      if (v['@graph']) walk(v['@graph']);
      if (v.itemListElement) walk(v.itemListElement);
    }
  };
  walk(value);
  return out;
}

function resolveMaybeUrl(value, baseUrl) {
  if (!value || typeof value !== 'string') return null;
  try { return new URL(value.replace(/\\u002F/g, '/'), baseUrl).href; } catch { return null; }
}

async function findVerifiedImageFromCandidates(candidates) {
  for (const candidate of candidates) {
    const clean = cleanImageUrl(candidate);
    if (!clean) continue;
    if (isTrustedImageUrl(clean)) {
      const verified = await verifyImage(clean);
      if (verified) return verified;
      continue;
    }
    const verified = await verifyImage(clean);
    if (verified) return verified;
  }
  return null;
}

async function verifyImage(imageUrl) {
  const clean = cleanImageUrl(imageUrl);
  if (!clean) return null;
  try {
    const resp = await fetch(IMG_PROXY + '/verify?url=' + encodeURIComponent(clean), { headers: { 'Accept': 'application/json' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.ok ? clean : null;
  } catch { return null; }
}

async function findVerifiedImage(apiKey, productName, model) {
  if (!productName || productName === 'Unknown Product') return null;
  try {
    const resp = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          { role: 'system', content: 'Find a real, working direct product image URL for the exact product. Prefer manufacturer, Best Buy, Shopify, webfronts, or image CDN URLs. Return ONLY direct image URLs or NONE. Do not guess.' },
          { role: 'user', content: 'Product: ' + productName + (model ? ' | Model: ' + model : '') }
        ],
        max_tokens: 300
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    const urls = text.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
    return await findVerifiedImageFromCandidates(urls.map(u => u.replace(/[.,;:!?)]+$/, '')));
  } catch { return null; }
}

async function extractOgImage(url) {
  const page = await fetchProductPage(url);
  if (!page.html) return null;
  const evidence = extractPageEvidence(page.html, page.finalUrl || url);
  return await findVerifiedImageFromCandidates(evidence.imageCandidates);
}

function normalizeProductData(data) {
  const out = data && typeof data === 'object' ? data : {};
  return {
    name: cleanText(out.name || 'Unknown Product').slice(0, 120),
    model: cleanText(out.model || out.sku || ''),
    brand: cleanText(out.brand || ''),
    productType: cleanText(out.productType || out.product_type || ''),
    dim: cleanText(out.dim || out.dimensions || ''),
    notes: cleanText(out.notes || ''),
    price: typeof out.price === 'number' ? out.price : Number(String(out.price || '').replace(/[^0-9.]/g, '')) || 0,
    image: out.image || null,
    blurb: cleanText(out.blurb || ''),
    citations: Array.isArray(out.citations) ? out.citations.filter(Boolean) : [],
    pros: Array.isArray(out.pros) ? out.pros.map(cleanText).filter(Boolean) : [],
    cons: Array.isArray(out.cons) ? out.cons.map(cleanText).filter(Boolean) : [],
    rating: typeof out.rating === 'number' ? out.rating : parseInt(out.rating) || 0,
    features: Array.isArray(out.features) ? out.features.map(cleanText).filter(Boolean) : [],
    extractorConfidence: typeof out.extractorConfidence === 'number' ? out.extractorConfidence : (typeof out.confidence === 'number' ? out.confidence : null),
    extractorWarnings: Array.isArray(out.extractorWarnings) ? out.extractorWarnings : (Array.isArray(out.warnings) ? out.warnings : []),
  };
}

async function extractProductFromUrl(apiKey, url, evidence, expectedCategory) {
  const sysMsg = `You extract exactly one product from the supplied URL and page evidence. Return ONLY valid JSON.

Hard rules:
- Extract the product sold on the input URL only. Do not substitute a related product, search result, auction item, catalog category, or generic brand page.
- If the page evidence is insufficient or blocked, return confidence below 0.5 and explain the uncertainty in warnings.
- Prefer the page title, JSON-LD Product data, SKU/model, and exact source URL over broad web search snippets.
- Do not invent dimensions, prices, images, pros, cons, or model numbers.
- If price is call-for-price or unavailable, set price to 0 and include "call for price" in notes.
- Include productType such as refrigerator, dishwasher, range, microwave, sink, faucet, range hood, medicine cabinet, vanity, toilet, tub, tile, flooring, lighting, cabinet, hardware, paint, bed, closet system.

Return this exact JSON shape:
{
  "name": "specific product name, not just brand",
  "brand": "brand if known",
  "model": "model/SKU if known",
  "productType": "normalized product type",
  "dim": "dimensions, empty only if truly unavailable",
  "notes": "important caveats, call-for-price, install constraints",
  "price": 0,
  "image": "direct image URL or null",
  "blurb": "2-3 sentence review for a compact Clinton Hill Coops renovation",
  "pros": ["pro 1", "pro 2", "pro 3"],
  "cons": ["con 1", "con 2"],
  "rating": 7,
  "features": ["feature 1", "feature 2"],
  "confidence": 0.0,
  "warnings": ["warning if uncertain"]
}`;

  const evidenceMsg = JSON.stringify({
    inputUrl: url,
    expectedCategory: expectedCategory || null,
    pageTitle: evidence.title || null,
    pageDescription: evidence.description || null,
    jsonLdProducts: evidence.products.slice(0, 5),
    priceCandidates: evidence.priceCandidates.slice(0, 5),
    imageCandidates: evidence.imageCandidates.slice(0, 5),
  });

  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'sonar',
      messages: [
        { role: 'system', content: sysMsg },
        { role: 'user', content: evidenceMsg }
      ],
      max_tokens: 1200
    }),
  });

  if (!resp.ok) throw new Error('Perplexity error ' + resp.status);
  const result = await resp.json();
  const text = result.choices?.[0]?.message?.content || '';
  const citations = result.citations || [];
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { name: 'Unknown Product', dim: '', notes: 'Extractor did not return JSON', price: 0, image: null, blurb: text, citations, pros: [], cons: [], rating: 0, features: [], confidence: 0, warnings: ['no_json'] };
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return { ...parsed, citations, extractorConfidence: parsed.confidence, extractorWarnings: parsed.warnings || [] };
  } catch {
    return { name: 'Unknown Product', dim: '', notes: 'Extractor returned malformed JSON', price: 0, image: null, blurb: text, citations, pros: [], cons: [], rating: 0, features: [], confidence: 0, warnings: ['malformed_json'] };
  }
}

function validateProductData(data, { url, expectedCategory, evidence, page }) {
  const errors = [];
  const warnings = [];
  let score = 1;
  const add = (list, code, message, penalty, severity = 'warning') => {
    list.push({ code, message, severity });
    score -= penalty;
  };

  if (!page.html) add(warnings, 'page_fetch_failed', 'Could not fetch product page evidence directly.', 0.15);
  if (!data.name || data.name === 'Unknown Product') add(errors, 'bad_name', 'No specific product name was extracted.', 0.35, 'error');
  if (isGenericBrandOnly(data.name, evidence)) add(errors, 'generic_name', 'Extracted name appears to be only a brand or seller name.', 0.3, 'error');
  if (!data.dim) add(errors, 'missing_dimensions', 'Dimensions were not extracted.', 0.2, 'error');
  if (!data.price && !/call\s*for\s*price|price unavailable|contact/i.test(data.notes || '')) add(errors, 'missing_price', 'Price is missing and notes do not say call for price.', 0.25, 'error');
  if (!data.image) add(warnings, 'missing_verified_image', 'No verified direct product image URL was found.', 0.12);
  if (!data.blurb || !data.pros.length || !data.cons.length || !data.features.length || !data.rating) add(errors, 'incomplete_review', 'AI review fields are incomplete.', 0.22, 'error');
  if (data.rating && (data.rating < 1 || data.rating > 10)) add(warnings, 'rating_out_of_range', 'Rating is outside 1-10.', 0.08);

  const sourceHost = host(url);
  const citationHosts = (data.citations || []).map(host).filter(Boolean);
  const hasSourceCitation = citationHosts.some(h => h === sourceHost || h.endsWith('.' + sourceHost) || sourceHost.endsWith('.' + h));
  if (!page.html && !hasSourceCitation && sourceHost) add(warnings, 'source_not_cited', 'Extractor citations do not include the source retailer host.', 0.15);

  if (evidence.title || evidence.products.length) {
    const evidenceText = [evidence.title, ...evidence.products.map(p => [p.brand, p.name, p.sku].join(' '))].join(' ').toLowerCase();
    const extractedText = [data.brand, data.name, data.model].join(' ').toLowerCase();
    const tokens = meaningfulTokens(extractedText);
    const overlap = tokens.filter(t => evidenceText.includes(t)).length;
    if (tokens.length >= 3 && overlap < Math.min(2, tokens.length)) {
      add(errors, 'evidence_mismatch', 'Extracted product does not match page title/JSON-LD evidence.', 0.35, 'error');
    }
  }

  if (expectedCategory) {
    const expected = normalizeCategory(expectedCategory);
    const actual = normalizeCategory(data.productType || data.name);
    if (expected && actual && expected !== actual) {
      add(errors, 'category_mismatch', `Product looks like ${actual}, not ${expectedCategory}.`, 0.25, 'error');
    }
  }

  const extractorConfidence = typeof data.extractorConfidence === 'number' ? data.extractorConfidence : null;
  if (extractorConfidence !== null && extractorConfidence < 0.55) add(errors, 'low_extractor_confidence', 'Extractor reported low confidence.', 0.3, 'error');
  for (const warning of data.extractorWarnings || []) warnings.push({ code: 'extractor_warning', message: String(warning), severity: 'warning' });

  const actionableWarnings = warnings.filter(w => w.code !== 'extractor_warning');
  const confidence = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  return { errors, warnings, confidence, needsReview: errors.length > 0 || actionableWarnings.length > 0 || confidence < 0.85 };
}

function host(value) {
  try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

function meaningfulTokens(text) {
  return Array.from(new Set(String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []))
    .filter(t => !['the', 'and', 'with', 'for', 'product', 'stainless', 'steel', 'white', 'black', 'inch', 'inches', 'model', 'home', 'depot', 'lowes', 'wayfair'].includes(t));
}

function isGenericBrandOnly(name, evidence) {
  const n = cleanText(name).toLowerCase();
  if (!n) return false;
  const genericBrands = ['latitude run', 'ge', 'ge profile', 'samsung', 'bosch', 'blomberg', 'lg', 'whirlpool', 'kitchenaid', 'swiss madison'];
  if (!genericBrands.includes(n)) return false;
  const evidenceNames = evidence.products.map(p => cleanText(p.name).toLowerCase()).filter(Boolean);
  return !evidenceNames.some(e => e && e !== n && e.includes(n));
}

function normalizeCategory(text) {
  const s = String(text || '').toLowerCase();
  const map = [
    ['medicine cabinet', /medicine|mirror cabinet/],
    ['bathroom vanity', /vanity/],
    ['toilet', /toilet/],
    ['range hood', /range hood|hood|ventilation/],
    ['microwave', /microwave/],
    ['stove', /range|stove|oven|cooktop/],
    ['dishwasher', /dishwasher/],
    ['refrigerator', /refrigerator|fridge|freezer/],
    ['kitchen faucet', /faucet/],
    ['kitchen sink', /sink/],
    ['shower/tub', /shower|tub|bathtub/],
    ['closet system', /closet|wardrobe/],
    ['bed', /bed|mattress/],
    ['lighting', /lighting|light|lamp/],
    ['flooring', /floor|tile/],
    ['cabinets', /cabinet/],
  ];
  for (const [label, re] of map) if (re.test(s)) return label;
  return '';
}

async function generateStructuredReview(apiKey, name, price, dim, notes) {
  const sysMsg = `You help a couple renovating a pre-war Brooklyn apartment in the Clinton Hill Coops. Return ONLY valid JSON with this structure:
{
  "blurb": "2-3 sentence review. Focus on fit for compact NYC kitchen or apartment renovation, real review insights, energy efficiency, value. Under 60 words.",
  "pros": ["pro 1", "pro 2", "pro 3"],
  "cons": ["con 1", "con 2"],
  "rating": 7,
  "features": ["feature 1", "feature 2"]
}`;
  const userMsg = 'Product: ' + name + (price ? ' ($' + price + ')' : '') + (dim ? ' | Dimensions: ' + dim : '') + (notes ? ' | Notes: ' + notes : '');
  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'sonar', messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }], max_tokens: 500 }),
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
