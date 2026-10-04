CREATE TABLE IF NOT EXISTS contacts (
  phone TEXT PRIMARY KEY,
  name TEXT,
  last_seen TEXT NOT NULL,
  marketing_opt_in INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  phone TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'menu',
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  guests INTEGER NOT NULL,
  event_type TEXT DEFAULT 'mesa',
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  items TEXT NOT NULL,
  total REAL NOT NULL DEFAULT 0,
  address TEXT,
  payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  eta_minutes INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS waitlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  guests INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting',
  created_at TEXT NOT NULL,
  notified_at TEXT
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_phone TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  responsible TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  guests INTEGER NOT NULL,
  details TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS internal_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_phone TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_reservations_date ON reservations(date, status);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);

CREATE TABLE IF NOT EXISTS inbox (
  message_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  payload TEXT NOT NULL,
  reply TEXT,
  status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','completed','sent')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_commits (
  message_id TEXT PRIMARY KEY REFERENCES inbox(message_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  destination TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  reference TEXT NOT NULL DEFAULT '',
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  last_error TEXT,
  next_attempt_at TEXT NOT NULL,
  whatsapp_message_id TEXT,
  delivery_status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS product_availability (
  product_id INTEGER PRIMARY KEY,
  available INTEGER NOT NULL CHECK(available IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','assigned','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_outbox_whatsapp_message ON outbox(whatsapp_message_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_phone_status ON handoffs(phone,status);
CREATE INDEX IF NOT EXISTS idx_events_reminders ON events(reminder_sent,event_date);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(phone,created_at);
CREATE INDEX IF NOT EXISTS idx_reservations_phone ON reservations(phone,created_at);

CREATE TABLE IF NOT EXISTS simulation_records (
  table_name TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  PRIMARY KEY(table_name,record_id)
);
