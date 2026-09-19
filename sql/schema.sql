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
