export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for API routes
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // API routes
    if (path.startsWith('/api/')) {
      try {
        return await handleAPI(request, env, path, cors);
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: cors });
      }
    }

    // Serve the HTML app for everything else
    return await serveHTML(env);
  }
};

async function serveHTML(env) {
  const ghUrl = env.GITHUB_RAW_URL;
  const resp = await fetch(ghUrl, { cf: { cacheTtl: 300, cacheEverything: true } });
  const html = await resp.text();
  return new Response(html, {
    headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'public, max-age=300' },
  });
}

async function handleAPI(request, env, path, cors) {
  const db = env.DB;
  const method = request.method;
  const json = (data, status = 200) => Response.json(data, { status, headers: cors });

  // GET /api/data — return all categories, products, and selections
  if (path === '/api/data' && method === 'GET') {
    const [categories, products, selections] = await Promise.all([
      db.prepare('SELECT name FROM categories ORDER BY sort_order').all(),
      db.prepare('SELECT * FROM products ORDER BY category, created_at').all(),
      db.prepare('SELECT * FROM selections').all(),
    ]);

    // Group products by category
    const data = {};
    for (const cat of categories.results) {
      data[cat.name] = [];
    }
    for (const p of products.results) {
      if (!data[p.category]) data[p.category] = [];
      data[p.category].push({
        ...p,
        citations: JSON.parse(p.citations || '[]'),
        pros: JSON.parse(p.pros || '[]'),
        cons: JSON.parse(p.cons || '[]'),
        features: JSON.parse(p.features || '[]'),
      });
    }

    // Build selections map
    const selected = {};
    for (const s of selections.results) {
      if (s.product_id) selected[s.category] = s.product_id;
    }

    return json({ data, selected });
  }

  // POST /api/products — add a product
  if (path === '/api/products' && method === 'POST') {
    const body = await request.json();
    const { id, category, name, dim, notes, price, url, image, blurb, citations, pros, cons, rating, features } = body;
    const productId = id || crypto.randomUUID();

    await db.prepare(`
      INSERT INTO products (id, category, name, dim, notes, price, url, image, blurb, citations, pros, cons, rating, features)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      productId, category, name || '',
      dim || '', notes || '', price || 0, url || '', image || null,
      blurb || '', JSON.stringify(citations || []), JSON.stringify(pros || []),
      JSON.stringify(cons || []), rating || 0, JSON.stringify(features || [])
    ).run();

    return json({ success: true, id: productId });
  }

  // PUT /api/products/:id — update a product
  if (path.match(/^\/api\/products\/[^/]+$/) && method === 'PUT') {
    const productId = path.split('/').pop();
    const body = await request.json();
    const fields = [];
    const values = [];

    for (const [key, val] of Object.entries(body)) {
      if (['name', 'dim', 'notes', 'price', 'url', 'image', 'blurb', 'rating'].includes(key)) {
        fields.push(`${key} = ?`);
        values.push(val);
      }
      if (['citations', 'pros', 'cons', 'features'].includes(key)) {
        fields.push(`${key} = ?`);
        values.push(JSON.stringify(val));
      }
    }

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(productId);
      await db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    }

    return json({ success: true });
  }

  // DELETE /api/products/:id — delete a product
  if (path.match(/^\/api\/products\/[^/]+$/) && method === 'DELETE') {
    const productId = path.split('/').pop();
    await db.prepare('DELETE FROM products WHERE id = ?').bind(productId).run();
    // Also clear any selection pointing to this product
    await db.prepare('DELETE FROM selections WHERE product_id = ?').bind(productId).run();
    return json({ success: true });
  }

  // PUT /api/selections — update selections { category: productId }
  if (path === '/api/selections' && method === 'PUT') {
    const body = await request.json();
    const stmt = db.prepare(`
      INSERT INTO selections (category, product_id, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(category) DO UPDATE SET product_id = ?, updated_at = datetime('now')
    `);
    const batch = [];
    for (const [category, productId] of Object.entries(body)) {
      batch.push(stmt.bind(category, productId || null, productId || null));
    }
    if (batch.length > 0) {
      await db.batch(batch);
    }
    return json({ success: true });
  }

  // POST /api/categories — add a category
  if (path === '/api/categories' && method === 'POST') {
    const { name } = await request.json();
    if (!name) return json({ error: 'name required' }, 400);
    const maxOrder = await db.prepare('SELECT MAX(sort_order) as mx FROM categories').first();
    await db.prepare('INSERT OR IGNORE INTO categories (name, sort_order) VALUES (?, ?)')
      .bind(name, (maxOrder?.mx || 0) + 1).run();
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}
