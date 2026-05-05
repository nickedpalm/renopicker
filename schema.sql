-- Products table
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  dim TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  price REAL DEFAULT 0,
  url TEXT DEFAULT '',
  image TEXT,
  blurb TEXT DEFAULT '',
  citations TEXT DEFAULT '[]',
  pros TEXT DEFAULT '[]',
  cons TEXT DEFAULT '[]',
  rating REAL DEFAULT 0,
  features TEXT DEFAULT '[]',
  needs_review INTEGER DEFAULT 0,
  source_confidence REAL,
  source_metadata TEXT,
  validation_errors TEXT,
  validation_warnings TEXT,
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Selections table (one per category)
CREATE TABLE IF NOT EXISTS selections (
  category TEXT PRIMARY KEY,
  product_id TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Categories table
CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY,
  sort_order INTEGER DEFAULT 0
);

-- Seed categories
INSERT OR IGNORE INTO categories (name, sort_order) VALUES
  ('Refrigerator', 0),
  ('Dishwasher', 1),
  ('Stove', 2),
  ('Microwave', 3),
  ('Sink', 4);
