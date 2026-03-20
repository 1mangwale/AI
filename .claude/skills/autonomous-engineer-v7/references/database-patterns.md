# Database Patterns — Schema, Indexing, Optimization

## Default: PostgreSQL

Unless you have a specific reason for something else, use PostgreSQL.
It handles: relational, JSON, full-text search, vectors, time-series (with extensions).

---

## 1. Schema Design Patterns

### Naming Conventions

```sql
-- Tables: plural, snake_case
users, orders, order_items, user_preferences

-- Columns: snake_case
user_id, created_at, is_active, total_amount

-- Primary keys: id (bigint or uuid)
id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY
-- or
id UUID DEFAULT gen_random_uuid() PRIMARY KEY

-- Foreign keys: table_singular_id
user_id, order_id, product_id

-- Timestamps: always include
created_at TIMESTAMPTZ DEFAULT NOW(),
updated_at TIMESTAMPTZ DEFAULT NOW()

-- Soft delete: use deleted_at, not is_deleted
deleted_at TIMESTAMPTZ
```

### Standard Columns (Every Table)

```sql
CREATE TABLE example (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ... domain columns ...
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  deleted_at TIMESTAMPTZ  -- soft delete
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_example_updated_at
  BEFORE UPDATE ON example
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
```

### UUID vs BIGINT

| Use | Type | Why |
|-----|------|-----|
| Internal IDs | BIGINT | Faster, smaller, sortable |
| External/API IDs | UUID | No enumeration, safe to expose |
| Distributed systems | UUID | No coordination needed |

```sql
-- Hybrid approach (recommended)
CREATE TABLE orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,  -- internal
  external_id UUID DEFAULT gen_random_uuid() UNIQUE,    -- API
  -- ...
);
```

---

## 2. Relationship Patterns

### One-to-Many

```sql
-- Users have many orders
CREATE TABLE users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  total_amount DECIMAL(10,2) NOT NULL
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
```

### Many-to-Many

```sql
-- Users have many roles, roles have many users
CREATE TABLE users (id BIGINT PRIMARY KEY, ...);
CREATE TABLE roles (id BIGINT PRIMARY KEY, name VARCHAR(50) UNIQUE);

CREATE TABLE user_roles (
  user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  role_id BIGINT REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, role_id)
);
```

### Self-Referential (Tree)

```sql
-- Categories with parent-child
CREATE TABLE categories (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  parent_id BIGINT REFERENCES categories(id),
  path LTREE  -- for efficient tree queries (requires ltree extension)
);

CREATE INDEX idx_categories_path ON categories USING GIST (path);

-- Query all descendants
SELECT * FROM categories WHERE path <@ 'root.electronics';
```

### Polymorphic (Multiple Parent Types)

```sql
-- Comments can belong to posts OR products
-- Option 1: Separate tables (preferred)
CREATE TABLE post_comments (
  id BIGINT PRIMARY KEY,
  post_id BIGINT REFERENCES posts(id),
  content TEXT
);

CREATE TABLE product_comments (
  id BIGINT PRIMARY KEY,
  product_id BIGINT REFERENCES products(id),
  content TEXT
);

-- Option 2: Single table with type (use carefully)
CREATE TABLE comments (
  id BIGINT PRIMARY KEY,
  commentable_type VARCHAR(50) NOT NULL,  -- 'post' or 'product'
  commentable_id BIGINT NOT NULL,
  content TEXT,
  CONSTRAINT valid_type CHECK (commentable_type IN ('post', 'product'))
);

CREATE INDEX idx_comments_target ON comments(commentable_type, commentable_id);
```

---

## 3. Indexing Strategies

### When to Index

```
✓ Foreign keys (always)
✓ Columns in WHERE clauses
✓ Columns in ORDER BY
✓ Columns in JOIN conditions
✓ Unique constraints

✗ Low cardinality columns (boolean, status with few values)
✗ Frequently updated columns
✗ Small tables (< 1000 rows)
```

### Index Types

```sql
-- B-tree (default, most common)
CREATE INDEX idx_users_email ON users(email);

-- Partial index (only index some rows)
CREATE INDEX idx_orders_pending ON orders(created_at) 
  WHERE status = 'pending';

-- Composite index (multiple columns)
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at DESC);

-- GIN (for JSONB, arrays, full-text)
CREATE INDEX idx_users_metadata ON users USING GIN (metadata);

-- GiST (for geometric, ltree, ranges)
CREATE INDEX idx_locations_coords ON locations USING GIST (coordinates);

-- Covering index (include columns to avoid table lookup)
CREATE INDEX idx_orders_user_covering ON orders(user_id) 
  INCLUDE (status, total_amount);
```

### Composite Index Order

```sql
-- Rule: Most selective column first, equality before range

-- Good: user_id (equality) first, then created_at (range)
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at);

-- Query that uses it:
SELECT * FROM orders WHERE user_id = 123 AND created_at > '2026-01-01';

-- This query can't use the index efficiently:
SELECT * FROM orders WHERE created_at > '2026-01-01';
-- (would need separate index on created_at)
```

---

## 4. Query Optimization

### EXPLAIN ANALYZE (Always Use)

```sql
EXPLAIN ANALYZE 
SELECT * FROM orders 
WHERE user_id = 123 
ORDER BY created_at DESC 
LIMIT 10;
```

### What to Look For

```
✗ Seq Scan on large table (missing index)
✗ Nested Loop with high row counts (bad join)
✗ Sort with high cost (missing index for ORDER BY)
✗ Hash Join on large tables (might need index)
✓ Index Scan or Index Only Scan (good)
✓ Bitmap Index Scan (acceptable for multiple conditions)
```

### Common Fixes

```sql
-- Problem: Seq Scan
-- Fix: Add index
CREATE INDEX idx_orders_user_id ON orders(user_id);

-- Problem: Sort
-- Fix: Index with ORDER BY column
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at DESC);

-- Problem: Fetching too many rows
-- Fix: Add LIMIT, use cursor for large exports
SELECT * FROM orders WHERE user_id = 123 LIMIT 100;

-- Problem: N+1 queries
-- Fix: Use JOIN or batch fetch
SELECT o.*, u.name as user_name
FROM orders o
JOIN users u ON o.user_id = u.id
WHERE o.created_at > '2026-01-01';
```

### Pagination Patterns

```sql
-- OFFSET pagination (simple, slow on deep pages)
SELECT * FROM orders ORDER BY id LIMIT 20 OFFSET 100;

-- Cursor pagination (fast, recommended)
SELECT * FROM orders 
WHERE id > :last_id  -- cursor from previous page
ORDER BY id 
LIMIT 20;

-- Keyset pagination with multiple columns
SELECT * FROM orders
WHERE (created_at, id) < (:last_date, :last_id)
ORDER BY created_at DESC, id DESC
LIMIT 20;
```

---

## 5. JSON/JSONB Patterns

### When to Use

```
✓ Flexible schema (user preferences, metadata)
✓ Nested data that's read together
✓ Third-party API responses (store as-is)

✗ Data you query frequently (use columns)
✗ Data with relationships (use tables)
✗ Large documents (> 1MB)
```

### JSONB Queries

```sql
-- Create table with JSONB
CREATE TABLE products (
  id BIGINT PRIMARY KEY,
  name VARCHAR(255),
  attributes JSONB DEFAULT '{}'
);

-- Insert
INSERT INTO products (name, attributes) VALUES 
  ('Laptop', '{"brand": "Apple", "specs": {"ram": 16, "storage": 512}}');

-- Query
SELECT * FROM products WHERE attributes->>'brand' = 'Apple';
SELECT * FROM products WHERE attributes->'specs'->>'ram' = '16';
SELECT * FROM products WHERE attributes @> '{"brand": "Apple"}';

-- Index JSONB
CREATE INDEX idx_products_brand ON products ((attributes->>'brand'));
CREATE INDEX idx_products_attrs ON products USING GIN (attributes);
```

---

## 6. Multi-Tenancy

### Row-Level (Recommended for Most)

```sql
-- Add tenant_id to every table
CREATE TABLE orders (
  id BIGINT PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL,
  -- ...
);

CREATE INDEX idx_orders_tenant ON orders(tenant_id);

-- Row Level Security
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('app.tenant_id')::BIGINT);

-- Set tenant in application
SET app.tenant_id = '123';
SELECT * FROM orders;  -- Only sees tenant 123's orders
```

### Schema-Level (High Isolation)

```sql
-- One schema per tenant
CREATE SCHEMA tenant_123;

CREATE TABLE tenant_123.orders (...);

-- Switch schema in application
SET search_path TO tenant_123, public;
```

---

## 7. Migration Patterns

### Safe Migrations

```sql
-- Adding column (safe)
ALTER TABLE orders ADD COLUMN notes TEXT;

-- Adding NOT NULL column (safe with default)
ALTER TABLE orders ADD COLUMN status VARCHAR(20) DEFAULT 'pending' NOT NULL;

-- Renaming column (DANGEROUS in production)
-- Do this instead:
-- 1. Add new column
ALTER TABLE orders ADD COLUMN order_status VARCHAR(20);
-- 2. Backfill
UPDATE orders SET order_status = status;
-- 3. Update application to use new column
-- 4. Drop old column (later)
ALTER TABLE orders DROP COLUMN status;

-- Adding index without locking
CREATE INDEX CONCURRENTLY idx_orders_status ON orders(status);
```

### Migration Checklist

```
□ Can this run while app is serving traffic?
□ Is it reversible?
□ Does it lock tables? For how long?
□ Does it need backfill? How long?
□ Tested on production-sized data?
```

---

## 8. Connection Pooling

### Why

```
Database connections are expensive (memory, auth).
Use a pool to reuse connections.
```

### Implementation

```typescript
// prisma/schema.prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  // Use connection pool
  // DATABASE_URL="postgresql://...?connection_limit=20&pool_timeout=10"
}

// Or with external pooler (PgBouncer)
// Better for serverless (Vercel, Lambda)
```

### Pool Sizing

```
Optimal pool size = (core_count * 2) + disk_spindles

For most apps:
- Small: 5-10 connections
- Medium: 20-50 connections
- Large: 100+ with PgBouncer
```

---

## Quick Reference

### Performance Checklist

```
□ Every foreign key indexed
□ Every WHERE column indexed
□ EXPLAIN ANALYZE on slow queries
□ Cursor pagination (not OFFSET)
□ Connection pooling enabled
□ No N+1 queries
□ LIMIT on all queries
□ Proper data types (not VARCHAR for everything)
```

### Schema Checklist

```
□ id, created_at, updated_at on every table
□ Soft delete with deleted_at (not is_deleted)
□ Foreign keys with ON DELETE (CASCADE/SET NULL)
□ Constraints for data integrity
□ Meaningful names (not column1, column2)
□ UUID for external IDs, BIGINT for internal
```
