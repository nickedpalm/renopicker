-- Product import quality metadata.
-- Existing product rows are preserved; these columns only record future import state.

ALTER TABLE products ADD COLUMN needs_review INTEGER DEFAULT 0;
ALTER TABLE products ADD COLUMN source_confidence REAL;
ALTER TABLE products ADD COLUMN source_metadata TEXT;
ALTER TABLE products ADD COLUMN validation_errors TEXT;
ALTER TABLE products ADD COLUMN validation_warnings TEXT;
ALTER TABLE products ADD COLUMN source_url TEXT;
