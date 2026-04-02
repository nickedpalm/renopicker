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

    // Static assets (index.html) are served automatically by Cloudflare
    return env.ASSETS.fetch(request);
  }
};

async function handleAPI(request, env, path, cors) {
  const db = env.DB;
  const method = request.method;
  const json = (data, status = 200) => Response.json(data, { status, headers: cors });

  // GET /api/data — full state: rooms, categories (with search_query), products, selections
  if (path === '/api/data' && method === 'GET') {
    const [rooms, categories, products, selections, comments, people] = await Promise.all([
      db.prepare('SELECT * FROM rooms ORDER BY sort_order').all(),
      db.prepare('SELECT * FROM categories ORDER BY sort_order').all(),
      db.prepare('SELECT * FROM products ORDER BY category_id, sort_order, created_at').all(),
      db.prepare('SELECT * FROM selections').all(),
      db.prepare('SELECT * FROM comments ORDER BY created_at').all(),
      db.prepare('SELECT * FROM people ORDER BY name').all(),
    ]);

    // Group categories by room
    const roomList = rooms.results.map(r => ({
      ...r,
      categories: categories.results
        .filter(c => c.room_id === r.id)
        .map(c => ({
          id: c.id,
          name: c.name,
          search_query: c.search_query || '',
          sort_order: c.sort_order,
          products: [],
        })),
    }));

    // Group comments by product
    const commentsByProduct = {};
    for (const c of comments.results) {
      if (!commentsByProduct[c.product_id]) commentsByProduct[c.product_id] = [];
      commentsByProduct[c.product_id].push(c);
    }

    // Put products into their categories (keyed by category_id)
    const productsByCategory = {};
    for (const p of products.results) {
      const catId = p.category_id;
      if (!catId) continue;
      if (!productsByCategory[catId]) productsByCategory[catId] = [];
      productsByCategory[catId].push({
        ...p,
        qty: p.qty ?? 1,
        unit: p.unit || 'each',
        citations: JSON.parse(p.citations || '[]'),
        pros: JSON.parse(p.pros || '[]'),
        cons: JSON.parse(p.cons || '[]'),
        features: JSON.parse(p.features || '[]'),
        comments: commentsByProduct[p.id] || [],
      });
    }
    for (const room of roomList) {
      for (const cat of room.categories) {
        cat.products = productsByCategory[cat.id] || [];
      }
    }

    // Build selections map (keyed by category_id)
    const selected = {};
    for (const s of selections.results) {
      if (s.product_id) selected[s.category_id] = s.product_id;
    }

    return json({ rooms: roomList, selected, people: people.results });
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
    const { order } = await request.json(); // order: array of category IDs
    const stmt = db.prepare('UPDATE categories SET sort_order = ? WHERE id = ?');
    const batch = order.map((id, i) => stmt.bind(i, id));
    if (batch.length > 0) await db.batch(batch);
    return json({ success: true });
  }

  // PUT /api/products/reorder — update sort_order for products within a category
  if (path === '/api/products/reorder' && method === 'PUT') {
    const { order } = await request.json(); // array of product ids
    const stmt = db.prepare('UPDATE products SET sort_order = ? WHERE id = ?');
    const batch = order.map((id, i) => stmt.bind(i, id));
    if (batch.length > 0) await db.batch(batch);
    return json({ success: true });
  }

  // --- Categories ---

  // POST /api/categories — add a category
  if (path === '/api/categories' && method === 'POST') {
    const { id, name, room_id, search_query } = await request.json();
    if (!name) return json({ error: 'name required' }, 400);
    const catId = id || crypto.randomUUID();
    const maxOrder = await db.prepare('SELECT MAX(sort_order) as mx FROM categories').first();
    await db.prepare('INSERT INTO categories (id, name, room_id, search_query, sort_order) VALUES (?, ?, ?, ?, ?)')
      .bind(catId, name, room_id || null, search_query || '', (maxOrder?.mx ?? -1) + 1).run();
    return json({ success: true, id: catId });
  }

  // PUT /api/categories/:id — update category (name, search_query, room_id)
  if (path.match(/^\/api\/categories\/[^/]+$/) && method === 'PUT') {
    const catId = path.split('/').pop();
    const body = await request.json();
    const updates = [];
    const values = [];

    if (body.name !== undefined) { updates.push('name = ?'); values.push(body.name); }
    if (body.search_query !== undefined) { updates.push('search_query = ?'); values.push(body.search_query); }
    if (body.room_id !== undefined) { updates.push('room_id = ?'); values.push(body.room_id); }

    if (updates.length > 0) {
      values.push(catId);
      await db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run();
    }
    return json({ success: true });
  }

  // DELETE /api/categories/:id — delete a category and its products
  if (path.match(/^\/api\/categories\/[^/]+$/) && method === 'DELETE') {
    const catId = path.split('/').pop();
    await db.prepare('DELETE FROM products WHERE category_id = ?').bind(catId).run();
    await db.prepare('DELETE FROM selections WHERE category_id = ?').bind(catId).run();
    await db.prepare('DELETE FROM categories WHERE id = ?').bind(catId).run();
    return json({ success: true });
  }

  // --- Products ---

  // POST /api/products
  if (path === '/api/products' && method === 'POST') {
    const body = await request.json();
    const { id, category_id, name, dim, notes, price, url, image, blurb, citations, pros, cons, rating, features, qty, unit } = body;
    const productId = id || crypto.randomUUID();
    await db.prepare(`
      INSERT INTO products (id, category_id, name, dim, notes, price, url, image, blurb, citations, pros, cons, rating, features, qty, unit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      productId, category_id, name || '', dim || '', notes || '', price || 0, url || '', image || null,
      blurb || '', JSON.stringify(citations || []), JSON.stringify(pros || []),
      JSON.stringify(cons || []), rating || 0, JSON.stringify(features || []),
      qty ?? 1, unit || 'each'
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
      if (['name', 'dim', 'notes', 'price', 'url', 'image', 'blurb', 'rating', 'qty', 'unit'].includes(key)) {
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
      INSERT INTO selections (category_id, product_id, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(category_id) DO UPDATE SET product_id = ?, updated_at = datetime('now')
    `);
    const batch = [];
    for (const [categoryId, productId] of Object.entries(body)) {
      batch.push(stmt.bind(categoryId, productId || null, productId || null));
    }
    if (batch.length > 0) await db.batch(batch);
    return json({ success: true });
  }

  // --- People ---

  // POST /api/people
  if (path === '/api/people' && method === 'POST') {
    const { name } = await request.json();
    if (!name) return json({ error: 'name required' }, 400);
    const id = crypto.randomUUID();
    try {
      await db.prepare('INSERT INTO people (id, name) VALUES (?, ?)').bind(id, name.trim()).run();
    } catch (e) {
      // Unique constraint — person already exists
      const existing = await db.prepare('SELECT * FROM people WHERE name = ?').bind(name.trim()).first();
      if (existing) return json({ success: true, person: existing });
      throw e;
    }
    return json({ success: true, person: { id, name: name.trim() } });
  }

  // --- Comments ---

  // POST /api/comments
  if (path === '/api/comments' && method === 'POST') {
    const { product_id, author, body } = await request.json();
    if (!product_id || !body) return json({ error: 'product_id and body required' }, 400);
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO comments (id, product_id, author, body) VALUES (?, ?, ?, ?)')
      .bind(id, product_id, author || 'Anonymous', body).run();
    const comment = await db.prepare('SELECT * FROM comments WHERE id = ?').bind(id).first();
    return json({ success: true, comment });
  }

  // DELETE /api/comments/:id
  if (path.match(/^\/api\/comments\/[^/]+$/) && method === 'DELETE') {
    const commentId = path.split('/').pop();
    await db.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run();
    return json({ success: true });
  }

  return json({ error: 'Not found' }, 404);
}
