export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    if (path.startsWith('/api/')) {
      try {
        return await handleAPI(request, env, path, cors);
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: cors });
      }
    }

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

  // GET /api/data — full state: rooms, categories (with search_query), products, selections
  if (path === '/api/data' && method === 'GET') {
    const [rooms, categories, products, selections] = await Promise.all([
      db.prepare('SELECT * FROM rooms ORDER BY sort_order').all(),
      db.prepare('SELECT * FROM categories ORDER BY sort_order').all(),
      db.prepare('SELECT * FROM products ORDER BY category, created_at').all(),
      db.prepare('SELECT * FROM selections').all(),
    ]);

    // Group categories by room
    const roomList = rooms.results.map(r => ({
      ...r,
      categories: categories.results
        .filter(c => c.room_id === r.id)
        .map(c => ({
          name: c.name,
          search_query: c.search_query || '',
          sort_order: c.sort_order,
          products: [],
        })),
    }));

    // Put products into their categories
    const productsByCategory = {};
    for (const p of products.results) {
      if (!productsByCategory[p.category]) productsByCategory[p.category] = [];
      productsByCategory[p.category].push({
        ...p,
        citations: JSON.parse(p.citations || '[]'),
        pros: JSON.parse(p.pros || '[]'),
        cons: JSON.parse(p.cons || '[]'),
        features: JSON.parse(p.features || '[]'),
      });
    }
    for (const room of roomList) {
      for (const cat of room.categories) {
        cat.products = productsByCategory[cat.name] || [];
      }
    }

    // Build selections map
    const selected = {};
    for (const s of selections.results) {
      if (s.product_id) selected[s.category] = s.product_id;
    }

    return json({ rooms: roomList, selected });
  }

  // --- Rooms ---

  // POST /api/rooms — add a room
  if (path === '/api/rooms' && method === 'POST') {
    const { name } = await request.json();
    if (!name) return json({ error: 'name required' }, 400);
    const id = crypto.randomUUID();
    const maxOrder = await db.prepare('SELECT MAX(sort_order) as mx FROM rooms').first();
    await db.prepare('INSERT INTO rooms (id, name, sort_order) VALUES (?, ?, ?)')
      .bind(id, name, (maxOrder?.mx ?? -1) + 1).run();
    return json({ success: true, id });
  }

  // PUT /api/rooms/:id — update room name
  if (path.match(/^\/api\/rooms\/[^/]+$/) && method === 'PUT') {
    const roomId = path.split('/').pop();
    const { name } = await request.json();
    if (name !== undefined) {
      await db.prepare('UPDATE rooms SET name = ? WHERE id = ?').bind(name, roomId).run();
    }
    return json({ success: true });
  }

  // DELETE /api/rooms/:id — delete room (moves categories to unassigned)
  if (path.match(/^\/api\/rooms\/[^/]+$/) && method === 'DELETE') {
    const roomId = path.split('/').pop();
    await db.prepare('UPDATE categories SET room_id = NULL WHERE room_id = ?').bind(roomId).run();
    await db.prepare('DELETE FROM rooms WHERE id = ?').bind(roomId).run();
    return json({ success: true });
  }

  // PUT /api/rooms/reorder — update sort_order for all rooms
  if (path === '/api/rooms/reorder' && method === 'PUT') {
    const { order } = await request.json(); // array of room ids
    const stmt = db.prepare('UPDATE rooms SET sort_order = ? WHERE id = ?');
    const batch = order.map((id, i) => stmt.bind(i, id));
    if (batch.length > 0) await db.batch(batch);
    return json({ success: true });
  }

  // PUT /api/categories/reorder — update sort_order for categories within a room
  if (path === '/api/categories/reorder' && method === 'PUT') {
    const { room_id, order } = await request.json(); // order: array of category names
    const stmt = db.prepare('UPDATE categories SET sort_order = ? WHERE name = ? AND room_id = ?');
    const batch = order.map((name, i) => stmt.bind(i, name, room_id));
    if (batch.length > 0) await db.batch(batch);
    return json({ success: true });
  }

  // --- Categories ---

  // POST /api/categories — add a category
  if (path === '/api/categories' && method === 'POST') {
    const { name, room_id, search_query } = await request.json();
    if (!name) return json({ error: 'name required' }, 400);
    const maxOrder = await db.prepare('SELECT MAX(sort_order) as mx FROM categories').first();
    await db.prepare('INSERT OR IGNORE INTO categories (name, room_id, search_query, sort_order) VALUES (?, ?, ?, ?)')
      .bind(name, room_id || null, search_query || '', (maxOrder?.mx ?? -1) + 1).run();
    return json({ success: true });
  }

  // PUT /api/categories/:name — update category (name, search_query, room_id)
  if (path.match(/^\/api\/categories\/[^/]+$/) && method === 'PUT') {
    const catName = decodeURIComponent(path.split('/').pop());
    const body = await request.json();
    const updates = [];
    const values = [];

    if (body.search_query !== undefined) { updates.push('search_query = ?'); values.push(body.search_query); }
    if (body.room_id !== undefined) { updates.push('room_id = ?'); values.push(body.room_id); }
    if (body.new_name !== undefined && body.new_name !== catName) {
      // Rename: update category name + all products referencing it
      updates.push('name = ?');
      values.push(body.new_name);
      await db.prepare('UPDATE products SET category = ? WHERE category = ?').bind(body.new_name, catName).run();
      await db.prepare('UPDATE selections SET category = ? WHERE category = ?').bind(body.new_name, catName).run();
    }

    if (updates.length > 0) {
      values.push(catName);
      await db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE name = ?`).bind(...values).run();
    }
    return json({ success: true });
  }

  // DELETE /api/categories/:name — delete a category and its products
  if (path.match(/^\/api\/categories\/[^/]+$/) && method === 'DELETE') {
    const catName = decodeURIComponent(path.split('/').pop());
    await db.prepare('DELETE FROM products WHERE category = ?').bind(catName).run();
    await db.prepare('DELETE FROM selections WHERE category = ?').bind(catName).run();
    await db.prepare('DELETE FROM categories WHERE name = ?').bind(catName).run();
    return json({ success: true });
  }

  // --- Products ---

  // POST /api/products
  if (path === '/api/products' && method === 'POST') {
    const body = await request.json();
    const { id, category, name, dim, notes, price, url, image, blurb, citations, pros, cons, rating, features } = body;
    const productId = id || crypto.randomUUID();
    await db.prepare(`
      INSERT INTO products (id, category, name, dim, notes, price, url, image, blurb, citations, pros, cons, rating, features)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      productId, category, name || '', dim || '', notes || '', price || 0, url || '', image || null,
      blurb || '', JSON.stringify(citations || []), JSON.stringify(pros || []),
      JSON.stringify(cons || []), rating || 0, JSON.stringify(features || [])
    ).run();
    return json({ success: true, id: productId });
  }

  // PUT /api/products/:id
  if (path.match(/^\/api\/products\/[^/]+$/) && method === 'PUT') {
    const productId = path.split('/').pop();
    const body = await request.json();
    const fields = [];
    const values = [];
    for (const [key, val] of Object.entries(body)) {
      if (['name', 'dim', 'notes', 'price', 'url', 'image', 'blurb', 'rating'].includes(key)) {
        fields.push(`${key} = ?`); values.push(val);
      }
      if (['citations', 'pros', 'cons', 'features'].includes(key)) {
        fields.push(`${key} = ?`); values.push(JSON.stringify(val));
      }
    }
    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      values.push(productId);
      await db.prepare(`UPDATE products SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
    }
    return json({ success: true });
  }

  // DELETE /api/products/:id
  if (path.match(/^\/api\/products\/[^/]+$/) && method === 'DELETE') {
    const productId = path.split('/').pop();
    await db.prepare('DELETE FROM products WHERE id = ?').bind(productId).run();
    await db.prepare('DELETE FROM selections WHERE product_id = ?').bind(productId).run();
    return json({ success: true });
  }

  // PUT /api/selections
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
    if (batch.length > 0) await db.batch(batch);
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}
