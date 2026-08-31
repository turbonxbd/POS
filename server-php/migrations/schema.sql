-- POS TXbd - server-side schema.
--
-- Target: MySQL / MariaDB (Hostinger web hosting). The SQL is deliberately kept
-- to the common subset that also runs on SQLite, so the test suite can execute
-- every query in-process (see tests/bootstrap.php).
--
-- Design: hybrid document store. Each business entity keeps its full record as a
-- JSON string in `doc` (this is what the API returns, byte-identical to the old
-- in-browser mock). Alongside `doc` we materialise only the columns we filter /
-- sort / aggregate / make unique on. Nested arrays the mock kept inside a parent
-- record (product.variants, sale.taxLines, purchase.lines, sale_return.items)
-- stay inside that record's `doc`. `sale_items` and `payments` were already
-- their own collections and are their own tables here.
--
-- Multi-tenant: every business table carries `merchant_id`. Every API query is
-- scoped to the authenticated user's merchant server-side (app/Support/Tenant).

-- ------------------------------------------------------------- platform / infra

CREATE TABLE merchants (
  id          VARCHAR(36) PRIMARY KEY,
  name        VARCHAR(160) NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'active',
  doc         LONGTEXT NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  updated_at  VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);

CREATE TABLE meta (
  merchant_id VARCHAR(36) NOT NULL DEFAULT '',
  k           VARCHAR(64) NOT NULL,
  v           TEXT,
  PRIMARY KEY (merchant_id, k)
);

-- Running counters: invoice:<branch>, purchase, expense, register:<branch>,
-- sale_return:<branch>. Allocated inside a transaction (SELECT ... FOR UPDATE on
-- MySQL) so two terminals never get the same number.
CREATE TABLE sequences (
  merchant_id VARCHAR(36) NOT NULL,
  k           VARCHAR(80) NOT NULL,
  v           INT NOT NULL DEFAULT 0,
  PRIMARY KEY (merchant_id, k)
);

-- Server-side login sessions. The signed cookie only carries `id`.
CREATE TABLE sessions (
  id              VARCHAR(64) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  merchant_id     VARCHAR(36) NOT NULL,
  csrf            VARCHAR(64) NOT NULL,
  created_at      VARCHAR(32) NOT NULL,
  last_seen_at    VARCHAR(32) NOT NULL,
  expires_at      VARCHAR(32) NOT NULL,
  hard_expires_at VARCHAR(32) NOT NULL,
  user_agent      VARCHAR(255),
  ip              VARCHAR(64),
  revoked_at      VARCHAR(32)
);
CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expiry ON sessions (expires_at);

CREATE TABLE login_attempts (
  id    VARCHAR(36) PRIMARY KEY,
  email VARCHAR(190) NOT NULL,
  ip    VARCHAR(64),
  ok    TINYINT NOT NULL DEFAULT 0,
  at    VARCHAR(32) NOT NULL
);
CREATE INDEX login_attempts_lookup ON login_attempts (email, at);

-- ------------------------------------------------------------- org

CREATE TABLE businesses (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX businesses_merchant ON businesses (merchant_id);

CREATE TABLE branches (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  code VARCHAR(24),
  name VARCHAR(120),
  status VARCHAR(20),
  is_default TINYINT DEFAULT 0,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX branches_merchant ON branches (merchant_id);
CREATE UNIQUE INDEX branches_code ON branches (merchant_id, code);

CREATE TABLE roles (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL DEFAULT '',
  name VARCHAR(80),
  is_system TINYINT DEFAULT 0,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX roles_merchant ON roles (merchant_id);

CREATE TABLE users (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role_id VARCHAR(36),
  status VARCHAR(20),
  is_platform_admin TINYINT DEFAULT 0,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE UNIQUE INDEX users_email ON users (email);
CREATE INDEX users_merchant ON users (merchant_id);

CREATE TABLE employees (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  user_id VARCHAR(36),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX employees_merchant ON employees (merchant_id);
CREATE INDEX employees_user ON employees (user_id);

CREATE TABLE settings (
  id VARCHAR(64) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX settings_merchant ON settings (merchant_id);

CREATE TABLE subscriptions (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  plan_id VARCHAR(36),
  status VARCHAR(20),
  started_at VARCHAR(32),
  expires_at VARCHAR(32),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX subscriptions_merchant ON subscriptions (merchant_id);
CREATE INDEX subscriptions_status ON subscriptions (status, expires_at);

-- ------------------------------------------------------------- platform: plans, billing, support

-- Plans are PLATFORM-wide (merchant_id = ''). Shown on the public Live panel
-- and managed only from the Super Admin panel - one source of truth for pricing.
CREATE TABLE plans (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL DEFAULT '',
  name VARCHAR(80),
  price INT,
  billing_period VARCHAR(16),
  status VARCHAR(16),
  sort_order INT DEFAULT 0,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);

CREATE TABLE subscription_payments (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  subscription_id VARCHAR(36),
  plan_id VARCHAR(36),
  type VARCHAR(16) DEFAULT 'monthly',   -- initial | monthly | branch
  status VARCHAR(16) DEFAULT 'paid',    -- pending | paid | failed | refunded
  amount INT,
  method VARCHAR(24),
  period_start VARCHAR(32),
  period_end VARCHAR(32),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX subscription_payments_at ON subscription_payments (at);
CREATE INDEX subscription_payments_merchant ON subscription_payments (merchant_id);
CREATE INDEX subscription_payments_type ON subscription_payments (type, status);

-- Additional-branch purchase requests (beyond a plan's includedBranches).
CREATE TABLE branch_requests (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  status VARCHAR(16) DEFAULT 'pending', -- pending | paid | activated | rejected
  payment_id VARCHAR(36),
  branch_id VARCHAR(36),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX branch_requests_merchant ON branch_requests (merchant_id, status);

CREATE TABLE support_requests (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL DEFAULT '',
  status VARCHAR(16),
  subject VARCHAR(190),
  email VARCHAR(190),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX support_requests_status ON support_requests (status, at);

-- Public support chat (the Live site widget). No merchant_id - visitors are
-- anonymous; the thread is keyed by an unguessable id + visitor id.
CREATE TABLE chat_threads (
  id VARCHAR(36) PRIMARY KEY,
  visitor_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) DEFAULT 'open',   -- open | answered | closed
  email VARCHAR(190),
  last_message_at VARCHAR(32),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX chat_threads_status ON chat_threads (status, last_message_at);

CREATE TABLE chat_messages (
  id VARCHAR(36) PRIMARY KEY,
  thread_id VARCHAR(36) NOT NULL,
  sender VARCHAR(16) NOT NULL,         -- visitor | admin
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX chat_messages_thread ON chat_messages (thread_id, at);

-- One platform-wide settings record (id 'platform'): official contact details
-- (WhatsApp etc. used across the Live panel), billing defaults, gateway choice.
-- Gateway SECRET keys are NOT stored here - they live in server-php/config/.
CREATE TABLE platform_settings (
  id VARCHAR(36) PRIMARY KEY,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);

-- Super Admin notification feed (platform-wide, not merchant-scoped)
CREATE TABLE platform_notifications (
  id VARCHAR(36) PRIMARY KEY,
  type VARCHAR(32),
  is_read TINYINT DEFAULT 0,
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX platform_notifications_read ON platform_notifications (is_read, at);

-- ------------------------------------------------------------- catalog

CREATE TABLE categories (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  parent_id VARCHAR(36),
  name VARCHAR(120),
  status VARCHAR(20),
  sort_order INT,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX categories_merchant ON categories (merchant_id);
CREATE INDEX categories_parent ON categories (parent_id);

CREATE TABLE brands (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  name VARCHAR(120),
  status VARCHAR(20),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX brands_merchant ON brands (merchant_id);

CREATE TABLE taxes (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  name VARCHAR(80),
  is_default TINYINT DEFAULT 0,
  status VARCHAR(20),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX taxes_merchant ON taxes (merchant_id);

CREATE TABLE discounts (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  code VARCHAR(60),
  status VARCHAR(20),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX discounts_merchant ON discounts (merchant_id);
CREATE UNIQUE INDEX discounts_code ON discounts (merchant_id, code);

CREATE TABLE products (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  name VARCHAR(190),
  sku VARCHAR(80),
  barcode VARCHAR(64),
  category_id VARCHAR(36),
  subcategory_id VARCHAR(36),
  brand_id VARCHAR(36),
  supplier_id VARCHAR(36),
  tax_id VARCHAR(36),
  selling_price INT,
  cost_price INT,
  has_variants TINYINT DEFAULT 0,
  track_inventory TINYINT DEFAULT 1,
  status VARCHAR(20),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX products_merchant ON products (merchant_id);
CREATE INDEX products_category ON products (category_id);
CREATE INDEX products_brand ON products (brand_id);
CREATE INDEX products_status ON products (merchant_id, status);

-- Every sellable code (base product or a variant). Enforces per-merchant
-- uniqueness of SKUs and barcodes and powers O(1) POS barcode lookup.
CREATE TABLE product_codes (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  variant_id VARCHAR(36),
  kind VARCHAR(10) NOT NULL,
  code VARCHAR(80) NOT NULL
);
CREATE UNIQUE INDEX product_codes_unique ON product_codes (merchant_id, kind, code);
CREATE INDEX product_codes_product ON product_codes (product_id);

-- ------------------------------------------------------------- people

CREATE TABLE customers (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  name VARCHAR(160),
  phone VARCHAR(40),
  status VARCHAR(20),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX customers_merchant ON customers (merchant_id);
CREATE INDEX customers_phone ON customers (merchant_id, phone);

CREATE TABLE suppliers (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  name VARCHAR(160),
  phone VARCHAR(40),
  status VARCHAR(20),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  archived_at VARCHAR(32)
);
CREATE INDEX suppliers_merchant ON suppliers (merchant_id);

-- ------------------------------------------------------------- inventory

CREATE TABLE stock (
  id VARCHAR(120) PRIMARY KEY,           -- stk_<branch>_<product>_<variant|base>
  merchant_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  variant_id VARCHAR(36),
  quantity INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  avg_cost INT NOT NULL DEFAULT 0,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE UNIQUE INDEX stock_key ON stock (branch_id, product_id, variant_id);
CREATE INDEX stock_merchant ON stock (merchant_id);
CREATE INDEX stock_product ON stock (product_id);

CREATE TABLE inventory_transactions (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36) NOT NULL,
  product_id VARCHAR(36) NOT NULL,
  variant_id VARCHAR(36),
  type VARCHAR(24) NOT NULL,
  ref_type VARCHAR(24),
  ref_id VARCHAR(64),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL
);
CREATE INDEX invtx_merchant_at ON inventory_transactions (merchant_id, at);
CREATE INDEX invtx_branch_at ON inventory_transactions (branch_id, at);
CREATE INDEX invtx_product ON inventory_transactions (product_id, at);
CREATE INDEX invtx_ref ON inventory_transactions (ref_type, ref_id);

-- ------------------------------------------------------------- sales

CREATE TABLE register_sessions (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40),
  branch_id VARCHAR(36),
  cashier_id VARCHAR(36),
  status VARCHAR(20),
  opened_at VARCHAR(32),
  closed_at VARCHAR(32),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX regsess_merchant ON register_sessions (merchant_id);
CREATE INDEX regsess_branch ON register_sessions (branch_id, status);

CREATE TABLE sales (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  invoice_no VARCHAR(60) NOT NULL,
  idempotency_key VARCHAR(64),
  branch_id VARCHAR(36) NOT NULL,
  register_session_id VARCHAR(36),
  cashier_id VARCHAR(36),
  customer_id VARCHAR(36),
  status VARCHAR(24),
  grand_total INT,
  total_cost INT,
  created_at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE UNIQUE INDEX sales_invoice_no ON sales (merchant_id, invoice_no);
CREATE UNIQUE INDEX sales_idempotency ON sales (merchant_id, idempotency_key);
CREATE INDEX sales_branch_created ON sales (branch_id, created_at);
CREATE INDEX sales_merchant_created ON sales (merchant_id, created_at);
CREATE INDEX sales_customer ON sales (customer_id);
CREATE INDEX sales_session ON sales (register_session_id);

CREATE TABLE sale_items (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  sale_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36),
  product_id VARCHAR(36),
  variant_id VARCHAR(36),
  qty INT,
  line_total INT,
  cost_price INT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL
);
CREATE INDEX sale_items_sale ON sale_items (sale_id);
CREATE INDEX sale_items_merchant ON sale_items (merchant_id);
CREATE INDEX sale_items_product ON sale_items (product_id);

CREATE TABLE payments (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  sale_id VARCHAR(36),
  sale_return_id VARCHAR(36),
  branch_id VARCHAR(36),
  register_session_id VARCHAR(36),
  direction VARCHAR(8),
  method VARCHAR(24),
  amount INT,
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL
);
CREATE INDEX payments_merchant_at ON payments (merchant_id, at);
CREATE INDEX payments_sale ON payments (sale_id);
CREATE INDEX payments_branch_at ON payments (branch_id, at);
CREATE INDEX payments_session ON payments (register_session_id);

CREATE TABLE sale_returns (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40),
  sale_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36),
  customer_id VARCHAR(36),
  type VARCHAR(16),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX sale_returns_merchant_at ON sale_returns (merchant_id, at);
CREATE INDEX sale_returns_sale ON sale_returns (sale_id);

-- ------------------------------------------------------------- purchasing

CREATE TABLE purchases (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40) NOT NULL,
  branch_id VARCHAR(36),
  supplier_id VARCHAR(36),
  status VARCHAR(24),
  grand_total INT,
  created_at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE UNIQUE INDEX purchases_reference ON purchases (merchant_id, reference);
CREATE INDEX purchases_supplier ON purchases (supplier_id);
CREATE INDEX purchases_branch_created ON purchases (branch_id, created_at);

-- ------------------------------------------------------------- finance

CREATE TABLE expenses (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40),
  branch_id VARCHAR(36),
  category VARCHAR(60),
  amount INT,
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE UNIQUE INDEX expenses_reference ON expenses (merchant_id, reference);
CREATE INDEX expenses_branch_at ON expenses (branch_id, at);

-- ------------------------------------------------------------- system

CREATE TABLE audit_logs (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL DEFAULT '',
  action VARCHAR(40),
  entity VARCHAR(40),
  entity_id VARCHAR(64),
  actor_id VARCHAR(36),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL
);
CREATE INDEX audit_logs_merchant_at ON audit_logs (merchant_id, at);
CREATE INDEX audit_logs_entity ON audit_logs (entity, entity_id);

CREATE TABLE notifications (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  type VARCHAR(40),
  is_read TINYINT DEFAULT 0,
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX notifications_merchant ON notifications (merchant_id, is_read, at);

-- Product / logo images. Kept out of `doc` (large binary).
CREATE TABLE media (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  content_type VARCHAR(80) NOT NULL,
  bytes LONGBLOB NOT NULL,
  size INT NOT NULL,
  created_at VARCHAR(32) NOT NULL
);
CREATE INDEX media_merchant ON media (merchant_id);

-- ------------------------------------------------------------- inventory ops

CREATE TABLE stock_adjustments (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40),
  branch_id VARCHAR(36),
  type VARCHAR(16),
  reason VARCHAR(24),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX stock_adjustments_branch_at ON stock_adjustments (branch_id, at);
CREATE UNIQUE INDEX stock_adjustments_reference ON stock_adjustments (merchant_id, reference);

CREATE TABLE stock_transfers (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40),
  from_branch_id VARCHAR(36),
  to_branch_id VARCHAR(36),
  status VARCHAR(16),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX stock_transfers_merchant_at ON stock_transfers (merchant_id, at);
CREATE UNIQUE INDEX stock_transfers_reference ON stock_transfers (merchant_id, reference);

-- ------------------------------------------------------------- sales ops

CREATE TABLE held_sales (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36),
  cashier_id VARCHAR(36),
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX held_sales_branch ON held_sales (branch_id);
CREATE INDEX held_sales_cashier ON held_sales (cashier_id);

CREATE TABLE customer_ledger (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  customer_id VARCHAR(36) NOT NULL,
  type VARCHAR(24),
  ref_type VARCHAR(24),
  ref_id VARCHAR(64),
  amount INT,
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL
);
CREATE INDEX customer_ledger_customer ON customer_ledger (customer_id, at);

-- ------------------------------------------------------------- purchasing / finance ops

CREATE TABLE purchase_returns (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40),
  purchase_id VARCHAR(36),
  supplier_id VARCHAR(36),
  branch_id VARCHAR(36),
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX purchase_returns_merchant_at ON purchase_returns (merchant_id, at);
CREATE INDEX purchase_returns_supplier ON purchase_returns (supplier_id);

CREATE TABLE supplier_payments (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  reference VARCHAR(40),
  supplier_id VARCHAR(36) NOT NULL,
  amount INT,
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX supplier_payments_supplier ON supplier_payments (supplier_id, at);

CREATE TABLE register_movements (
  id VARCHAR(36) PRIMARY KEY,
  merchant_id VARCHAR(36) NOT NULL,
  session_id VARCHAR(36) NOT NULL,
  branch_id VARCHAR(36),
  direction VARCHAR(8),
  amount INT,
  at VARCHAR(32) NOT NULL,
  doc LONGTEXT NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX register_movements_session ON register_movements (session_id);
