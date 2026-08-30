const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
const db = new Database(path.join(dataDir, 'estimator.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- QuickBooks OAuth — single row (id=1), single connected company
CREATE TABLE IF NOT EXISTS qb_auth (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_token TEXT,
  refresh_token TEXT,
  realm_id TEXT,
  token_expires_at TEXT,
  environment TEXT DEFAULT 'production',
  connected_at TEXT
);

-- Business branding for generated PDFs — single row (id=1)
CREATE TABLE IF NOT EXISTS business_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  business_name TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  logo_filename TEXT,
  invoice_disclaimer TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- A project = one estimate being worked, whether pulled from QuickBooks or
-- entered manually. Holds both the customer-facing quote data and the
-- separate internal cost/profit planning data.
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_name TEXT NOT NULL,
  customer_name TEXT,
  customer_address TEXT,
  qb_estimate_id TEXT,
  qb_estimate_number TEXT,
  total_revenue REAL DEFAULT 0,
  material_draw_invoice_number TEXT,
  remaining_balance_invoice_number TEXT,
  completion_date TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Customer-facing line items, pulled from a QuickBooks estimate. Classified
-- by QB's own Item Type (Inventory/NonInventory = material, Service =
-- labor/other), with 'classification' overridable per item as a safety net.
CREATE TABLE IF NOT EXISTS project_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL DEFAULT 1,
  amount REAL NOT NULL,
  qb_item_type TEXT,          -- raw QuickBooks type, kept for reference
  classification TEXT NOT NULL CHECK(classification IN ('material','labor_other')),
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Internal cost planning — NOT shown to the customer. Kept deliberately
-- separate from QuickBooks' own item costs, per how Megan actually wants
-- to track this (her own numbers, not QB's).
CREATE TABLE IF NOT EXISTS project_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  cost REAL NOT NULL,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_labor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  worker_name TEXT NOT NULL,
  hours REAL NOT NULL,
  hourly_rate REAL NOT NULL,
  sort_order INTEGER DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_line_items_project ON project_line_items(project_id);
CREATE INDEX IF NOT EXISTS idx_materials_project ON project_materials(project_id);
CREATE INDEX IF NOT EXISTS idx_labor_project ON project_labor(project_id);
`);

function ensureDefaultUser() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (row.c === 0) {
    const username = process.env.DEFAULT_USERNAME || 'megan';
    const password = process.env.DEFAULT_PASSWORD || 'changeme';
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
    console.log(`Created default user "${username}" — CHANGE THIS PASSWORD after first login.`);
  }
}
ensureDefaultUser();

function ensureSettingsRow() {
  const row = db.prepare('SELECT COUNT(*) AS c FROM business_settings WHERE id = 1').get();
  if (row.c === 0) {
    db.prepare('INSERT INTO business_settings (id) VALUES (1)').run();
  }
}
ensureSettingsRow();

// Safe, additive migration: invoice_disclaimer may not exist yet on an
// already-deployed business_settings table — ADD COLUMN is safe here since
// it's just a plain nullable text field, no CHECK constraint involved.
function ensureInvoiceDisclaimerColumn() {
  const cols = db.prepare("PRAGMA table_info(business_settings)").all().map(c => c.name);
  if (!cols.includes('invoice_disclaimer')) {
    db.exec('ALTER TABLE business_settings ADD COLUMN invoice_disclaimer TEXT');
    console.log('Migrated business_settings table: added invoice_disclaimer column.');
  }
}
ensureInvoiceDisclaimerColumn();

module.exports = db;
