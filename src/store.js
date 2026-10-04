import { nowIso } from './config.js';

const ACTIVE_RESERVATIONS = ['pending', 'confirmed'];
const MAX_NOTIFICATION_ATTEMPTS = 5;

function safeId() {
  const words = crypto.getRandomValues(new Uint32Array(2));
  return 100_000_000_000 + Number(((BigInt(words[0]) << 32n) | BigInt(words[1])) % 900_000_000_000n);
}

function cleanError(error) {
  return String(error?.message || error || 'Falha no envio')
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redigido]')
    .replace(/((?:access_token|token|secret|authorization)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1[redigido]')
    .replace(/EAA[A-Za-z0-9]{20,}/g, '[redigido]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, 500);
}

function eventIso(value, timeZone = 'America/Sao_Paulo') {
  const text = String(value || '').trim();
  const local = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(text);
  if (local) {
    const desired = Date.UTC(Number(local[3]), Number(local[2]) - 1, Number(local[1]), Number(local[4]), Number(local[5]));
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    let guess = desired;
    for (let attempt = 0; attempt < 4; attempt++) {
      const parts = Object.fromEntries(formatter.formatToParts(guess).map(part => [part.type, part.value]));
      const shown = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
      if (shown === desired) return new Date(guess).toISOString();
      guess += desired - shown;
    }
    throw new Error('O horário do evento não existe no fuso configurado.');
  }
  const iso = text;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(iso)) throw new Error('A data do evento deve incluir horário e fuso.');
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Data de evento inválida.');
  return parsed.toISOString();
}

export class Store {
  constructor(db, { messageId, lastSeen, simulated = false } = {}) {
    if (!db?.prepare || !db?.batch) throw new Error('O banco D1 é obrigatório. Configure o binding DB e aplique o schema.');
    this.db = db;
    this.messageId = messageId || null;
    this.lastSeen = lastSeen;
    this.simulated = simulated;
    this.statements = [];
    this.batchStatements = null;
    this.completed = false;
    this.notificationSequence = 0;
    this.sessions = new Map();
    this.contacts = new Map();
    this.settings = new Map();
    this.productAvailability = new Map();
    this.records = new Map();
    this.originalRecords = new Map();
  }

  get deferred() { return Boolean((this.messageId && !this.completed) || this.batchStatements); }
  prepare(sql, bindings = []) { return this.db.prepare(sql).bind(...bindings); }
  async run(sql, ...bindings) {
    const statement = this.prepare(sql, bindings);
    if (this.deferred) {
      (this.messageId && !this.completed ? this.statements : this.batchStatements).push(statement);
      return { deferred: true, meta: { changes: 0 } };
    }
    return statement.run();
  }
  async first(sql, ...bindings) { return this.prepare(sql, bindings).first(); }
  async all(sql, ...bindings) { return (await this.prepare(sql, bindings).all()).results || []; }
  clearOverlay() {
    for (const map of [this.sessions, this.contacts, this.settings, this.productAvailability, this.records, this.originalRecords]) map.clear();
  }

  // D1 batches are transactional. Webhook batches stay deferred until completeMessage.
  async batch(callback) {
    if (this.deferred) return callback(this);
    this.batchStatements = [];
    try {
      const value = await callback(this);
      if (this.batchStatements.length) await this.db.batch(this.batchStatements);
      return value;
    } finally {
      this.batchStatements = null;
      this.clearOverlay();
    }
  }

  async receiveMessage(messageId, phone, payload) {
    if (!messageId) throw new Error('message_id é obrigatório.');
    const at = nowIso();
    const result = await this.prepare("INSERT OR IGNORE INTO inbox(message_id,phone,payload,status,created_at,updated_at) VALUES(?,?,?,'received',?,?)", [messageId, phone, JSON.stringify(payload), at, at]).run();
    return result.meta.changes === 1;
  }
  async getMessage(messageId = this.messageId) {
    const row = await this.first('SELECT * FROM inbox WHERE message_id=?', messageId);
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }
  async pendingMessages(limit = 50) {
    const rows = await this.all("SELECT * FROM inbox WHERE status='completed' ORDER BY rowid LIMIT ?", limit);
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  async receivedMessages(limit = 50) {
    const rows = await this.all("SELECT * FROM inbox WHERE status='received' ORDER BY rowid LIMIT ?", limit);
    return rows.map(row => ({ ...row, payload: JSON.parse(row.payload) }));
  }
  async completeMessage(reply) {
    if (!this.messageId) throw new Error('completeMessage exige messageId.');
    const existing = await this.getMessage();
    if (!existing) throw new Error('A mensagem precisa ser registrada na inbox antes do processamento.');
    if (existing.status === 'completed' || existing.status === 'sent') {
      this.statements = []; this.completed = true; this.clearOverlay();
      return existing.reply;
    }
    const at = nowIso();
    try {
      // The unique receipt aborts a concurrent duplicate batch before business mutations.
      await this.db.batch([
        this.prepare('INSERT INTO webhook_commits(message_id,created_at) VALUES(?,?)', [this.messageId, at]),
        ...this.statements,
        this.prepare("UPDATE inbox SET reply=?,status='completed',updated_at=? WHERE message_id=? AND status='received'", [String(reply || ''), at, this.messageId])
      ]);
      this.statements = []; this.completed = true; this.clearOverlay();
      return String(reply || '');
    } catch (error) {
      const saved = await this.getMessage();
      if (saved?.status === 'completed' || saved?.status === 'sent') {
        this.statements = []; this.completed = true; this.clearOverlay();
        return saved.reply;
      }
      throw error;
    }
  }
  async markMessageSent(messageId) {
    return this.run("UPDATE inbox SET status='sent',updated_at=? WHERE message_id=? AND status='completed'", nowIso(), messageId);
  }

  async saveContact(phone, name, lastSeen = this.lastSeen || nowIso()) {
    if (this.simulated) return;
    const previous = await this.getContact(phone);
    const at = new Date(lastSeen).toISOString();
    await this.run(`INSERT INTO contacts(phone,name,last_seen) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET name=CASE WHEN excluded.name='' THEN contacts.name ELSE excluded.name END,last_seen=MAX(contacts.last_seen,excluded.last_seen)`, phone, name || '', at);
    if (this.deferred) this.contacts.set(phone, { ...previous, phone, name: name || previous?.name || '', last_seen: previous?.last_seen > at ? previous.last_seen : at });
  }
  async getContact(phone) { return this.contacts.get(phone) || this.first('SELECT * FROM contacts WHERE phone=?', phone); }
  async getSession(phone) {
    if (this.sessions.has(phone)) return this.sessions.get(phone);
    const row = await this.first('SELECT state,data FROM sessions WHERE phone=?', phone);
    return row ? { state: row.state, data: JSON.parse(row.data || '{}') } : { state: 'menu', data: {} };
  }
  async setSession(phone, state, data = {}) {
    await this.run(`INSERT INTO sessions(phone,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(phone) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at`, phone, state, JSON.stringify(data), nowIso());
    if (this.deferred) this.sessions.set(phone, { state, data: JSON.parse(JSON.stringify(data)) });
  }
  async log(phone, action, details = '') {
    if (this.simulated) return;
    await this.run('INSERT INTO internal_log(actor_phone,action,details,created_at) VALUES(?,?,?,?)', phone, action, details, nowIso());
  }

  rememberRecord(table, row, original = null) {
    if (!this.deferred) return;
    const key = `${table}:${row.id}`;
    if (!this.originalRecords.has(key)) this.originalRecords.set(key, original);
    this.records.set(key, row);
  }
  async getRecord(table, id) {
    return this.records.get(`${table}:${id}`) || this.first(`SELECT * FROM ${table} WHERE id=?`, id);
  }
  async insertRecord(table, record) {
    const deferred = this.deferred;
    const values = deferred ? { id: safeId(), ...record } : record;
    const columns = Object.keys(values);
    const sql = `INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`;
    const result = this.simulated && !deferred
      ? (await this.db.batch([
          this.prepare(sql, Object.values(values)),
          this.prepare('INSERT INTO simulation_records(table_name,record_id) VALUES(?,last_insert_rowid())', [table])
        ]))[0]
      : await this.run(sql, ...Object.values(values));
    const id = deferred ? values.id : result.meta?.last_row_id;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error(`O banco não retornou um identificador válido para ${table}.`);
    if (this.simulated && deferred) await this.run('INSERT INTO simulation_records(table_name,record_id) VALUES(?,?)', table, id);
    this.rememberRecord(table, { ...record, id });
    return id;
  }
  async listRecords(table, sql, bindings, filter = () => true, limit = Infinity) {
    const rows = new Map((await this.all(sql, ...bindings)).map(row => [row.id, row]));
    for (const [key, row] of this.records) if (key.startsWith(`${table}:`)) rows.set(row.id, row);
    return [...rows.values()].filter(filter).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id - a.id).slice(0, limit);
  }
  async createReservation(r) {
    return this.insertRecord('reservations', { phone: r.phone, name: r.name, date: r.date, time: r.time, guests: r.guests, event_type: r.eventType || 'mesa', status: 'pending', notes: r.notes || '', created_at: nowIso() });
  }
  async createOrder(o) {
    const at = nowIso();
    return this.insertRecord('orders', { phone: o.phone, items: JSON.stringify(o.items), total: o.total ?? 0, address: o.address || '', payment_method: o.payment || '', status: 'received', eta_minutes: o.eta ?? 45, created_at: at, updated_at: at });
  }
  async createWaitlist(w) {
    return this.insertRecord('waitlist', { phone: w.phone, name: w.name, guests: w.guests, status: 'waiting', created_at: nowIso() });
  }
  async waitlistStatus() {
    const counts = await this.first("SELECT COUNT(*) AS groups_count,COALESCE(SUM(guests),0) AS people_count FROM waitlist AS w WHERE status='waiting' AND NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='waitlist' AND s.record_id=w.id)");
    for (const [key, current] of this.records) {
      if (!key.startsWith('waitlist:')) continue;
      const original = this.originalRecords.get(key);
      if (original?.status === 'waiting') { counts.groups_count--; counts.people_count -= original.guests; }
      if (current.status === 'waiting') { counts.groups_count++; counts.people_count += current.guests; }
    }
    return counts;
  }
  async createEvent(e) {
    return this.insertRecord('events', { phone: e.phone, name: e.name, event_date: eventIso(e.date, e.timezone), guests: e.guests, details: e.details || '', reminder_sent: 0, created_at: nowIso() });
  }
  async createIncident(i) {
    return this.insertRecord('incidents', { reporter_phone: i.phone, severity: i.severity, description: i.description, responsible: i.responsible || '', status: 'open', created_at: nowIso() });
  }
  async getOrder(id) { return this.getRecord('orders', id); }
  async getReservation(id) { return this.getRecord('reservations', id); }
  async getWaitlist(id) { return this.getRecord('waitlist', id); }
  async changeStatus(table, id, previous, status, updatedColumn) {
    const current = await this.getRecord(table, id);
    if (!current || current.status !== previous || previous === status) return false;
    const at = nowIso();
    const result = await this.run(`UPDATE ${table} SET status=?${updatedColumn ? `,${updatedColumn}=?` : ''} WHERE id=? AND status=?`, ...[status, ...(updatedColumn ? [at] : []), id, previous]);
    if (!this.deferred && result.meta.changes !== 1) return false;
    this.rememberRecord(table, { ...current, status, ...(updatedColumn ? { [updatedColumn]: at } : {}) }, current);
    return true;
  }
  async setOrderStatus(id, previous, status) { return this.changeStatus('orders', id, previous, status, 'updated_at'); }
  async setReservationStatus(id, previous, status) { return this.changeStatus('reservations', id, previous, status); }
  async setWaitlistStatus(id, previous, status) { return this.changeStatus('waitlist', id, previous, status, status === 'called' ? 'notified_at' : null); }
  async listOrders(phone) {
    return this.listRecords('orders', 'SELECT * FROM orders WHERE phone=? ORDER BY created_at DESC,id DESC LIMIT 5', [phone], row => row.phone === phone, 5);
  }
  async cancelReservation(phone, id) {
    const current = await this.getReservation(id);
    if (!current || current.phone !== phone || !ACTIVE_RESERVATIONS.includes(current.status)) return { meta: { changes: 0 } };
    const changed = await this.setReservationStatus(id, current.status, 'cancelled');
    return { deferred: this.deferred, meta: { changes: changed ? 1 : 0 } };
  }
  async updateReservation(phone, id, date, time, guests) {
    const current = await this.getReservation(id);
    if (!current || current.phone !== phone || !ACTIVE_RESERVATIONS.includes(current.status)) return { meta: { changes: 0 } };
    const result = await this.run("UPDATE reservations SET date=?,time=?,guests=?,status='pending' WHERE phone=? AND id=? AND status IN ('pending','confirmed')", date, time, guests, phone, id);
    if (this.deferred) this.rememberRecord('reservations', { ...current, date, time, guests, status: 'pending' }, current);
    return this.deferred ? { deferred: true, meta: { changes: 1 } } : result;
  }
  async listReservations(phone) {
    return this.listRecords('reservations', "SELECT * FROM reservations WHERE phone=? AND status IN ('pending','confirmed') ORDER BY created_at DESC,id DESC LIMIT 5", [phone], row => row.phone === phone && ACTIVE_RESERVATIONS.includes(row.status), 5);
  }

  async availableProducts(products) {
    const availability = new Map((await this.all('SELECT product_id,available FROM product_availability')).map(row => [row.product_id, Boolean(row.available)]));
    for (const [id, value] of this.productAvailability) availability.set(id, value);
    return products.filter(product => availability.get(product.id) !== false);
  }
  async setProductAvailability(id, available) {
    await this.run('INSERT INTO product_availability(product_id,available,updated_at) VALUES(?,?,?) ON CONFLICT(product_id) DO UPDATE SET available=excluded.available,updated_at=excluded.updated_at', id, available ? 1 : 0, nowIso());
    if (this.deferred) this.productAvailability.set(id, Boolean(available));
  }
  async getSetting(key) {
    if (this.settings.has(key)) return this.settings.get(key);
    const row = await this.first('SELECT value FROM settings WHERE key=?', key);
    return row?.value ?? null;
  }
  async setSetting(key, value) {
    await this.run('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', key, String(value), nowIso());
    if (this.deferred) this.settings.set(key, String(value));
  }
  async createHandoff({ phone, name, text }) {
    const at = nowIso();
    return this.insertRecord('handoffs', { phone, name: name || '', text: text || '', status: 'open', created_at: at, updated_at: at });
  }
  async getHandoff(id) { return this.getRecord('handoffs', id); }
  async appendHandoff(phone, text) {
    const open = await this.listRecords('handoffs', "SELECT * FROM handoffs WHERE phone=? AND status IN ('open','assigned') ORDER BY created_at DESC,id DESC LIMIT 1", [phone], row => row.phone === phone && ['open', 'assigned'].includes(row.status), 1);
    const current = open[0];
    if (!current) return null;
    const at = nowIso();
    const combined = [current.text, text].filter(Boolean).join('\n');
    await this.run("UPDATE handoffs SET text=?,updated_at=? WHERE id=? AND status IN ('open','assigned')", combined, at, current.id);
    this.rememberRecord('handoffs', { ...current, text: combined, updated_at: at }, current);
    return current.id;
  }
  async setHandoffStatus(id, status) {
    const current = await this.getHandoff(id);
    return current ? this.changeStatus('handoffs', id, current.status, status, 'updated_at') : false;
  }

  async enqueueNotification(to, text, { kind = 'message', reference = '' } = {}) {
    if (this.simulated) return null;
    const at = nowIso();
    const key = this.messageId && !this.completed ? `${this.messageId}:notification:${this.notificationSequence++}` : reference ? `${kind}:${reference}:${to}` : crypto.randomUUID();
    const existing = await this.first('SELECT id FROM outbox WHERE dedupe_key=?', key);
    if (existing) return existing.id;
    const deferred = this.deferred;
    const id = deferred ? safeId() : null;
    const result = await this.run(`INSERT INTO outbox(${deferred ? 'id,' : ''}destination,text,kind,reference,dedupe_key,status,created_at,updated_at,next_attempt_at) VALUES(${deferred ? '?,' : ''}?,?,?,?,?,'pending',?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`, ...[...(deferred ? [id] : []), to, text, kind, String(reference), key, at, at, at]);
    if (deferred) return id;
    if (result.meta.changes === 1) return result.meta.last_row_id;
    return (await this.first('SELECT id FROM outbox WHERE dedupe_key=?', key)).id;
  }
  async pendingNotifications(limit = 20) {
    return this.all("SELECT *,destination AS \"to\" FROM outbox WHERE status='pending' AND next_attempt_at<=? ORDER BY created_at,id LIMIT ?", nowIso(), Math.max(1, Math.min(20, limit)));
  }
  async markNotificationSent(id, externalMessageId = null) {
    const at = nowIso();
    return this.run("UPDATE outbox SET status='sent',sent_at=?,updated_at=?,whatsapp_message_id=?,last_error=NULL WHERE id=? AND status='pending'", at, at, externalMessageId, id);
  }
  async markNotificationFailed(id, reason) {
    const row = await this.first('SELECT attempts FROM outbox WHERE id=?', id);
    if (!row) return;
    const next = new Date(Date.now() + Math.min(900_000, 30_000 * 2 ** Math.min(row.attempts, 5))).toISOString();
    return this.run("UPDATE outbox SET attempts=attempts+1,status=CASE WHEN attempts+1>=? THEN 'failed' ELSE 'pending' END,last_error=?,updated_at=?,next_attempt_at=? WHERE id=? AND status='pending'", MAX_NOTIFICATION_ATTEMPTS, cleanError(reason), nowIso(), next, id);
  }
  async recordDeliveryStatus(externalMessageId, status, errorCode = '') {
    if (!['sent', 'delivered', 'read', 'failed'].includes(status)) return;
    return this.prepare(`UPDATE outbox SET delivery_status=CASE WHEN delivery_status='read' AND ?!='failed' THEN 'read' WHEN delivery_status='delivered' AND ?='sent' THEN 'delivered' ELSE ? END,status=CASE WHEN ?='failed' THEN 'failed' ELSE status END,last_error=CASE WHEN ?='failed' THEN ? ELSE last_error END,updated_at=? WHERE whatsapp_message_id=?`, [status, status, status, status, status, `Falha final do WhatsApp (${cleanError(errorCode)})`, nowIso(), externalMessageId]).run();
  }

  async dashboard() {
    return {
      orders: await this.all("SELECT o.* FROM orders AS o WHERE NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='orders' AND s.record_id=o.id) ORDER BY created_at DESC,id DESC LIMIT 30"),
      reservations: await this.all("SELECT r.* FROM reservations AS r WHERE NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='reservations' AND s.record_id=r.id) ORDER BY created_at DESC,id DESC LIMIT 30"),
      events: await this.all("SELECT e.* FROM events AS e WHERE NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='events' AND s.record_id=e.id) ORDER BY created_at DESC,id DESC LIMIT 30"),
      waitlist: await this.all("SELECT w.* FROM waitlist AS w WHERE status IN ('waiting','called') AND NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='waitlist' AND s.record_id=w.id) ORDER BY created_at,id"),
      incidents: await this.all("SELECT i.* FROM incidents AS i WHERE status='open' AND NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='incidents' AND s.record_id=i.id) ORDER BY created_at DESC,id DESC"),
      handoffs: await this.all("SELECT h.* FROM handoffs AS h WHERE status IN ('open','assigned') AND NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='handoffs' AND s.record_id=h.id) ORDER BY created_at,id"),
      notifications: await this.all("SELECT *,destination AS \"to\" FROM outbox WHERE status IN ('pending','failed') OR delivery_status='failed' ORDER BY updated_at DESC LIMIT 30"),
      logs: await this.all('SELECT * FROM internal_log ORDER BY id DESC LIMIT 50')
    };
  }
  async dueEvents(at = nowIso()) {
    const start = new Date(at).toISOString();
    const end = new Date(new Date(start).getTime() + 24 * 60 * 60 * 1000).toISOString();
    return this.all("SELECT e.* FROM events AS e WHERE reminder_sent=0 AND event_date>=? AND event_date<=? AND NOT EXISTS(SELECT 1 FROM simulation_records AS s WHERE s.table_name='events' AND s.record_id=e.id) ORDER BY event_date", start, end);
  }
  async markEventReminder(id) { await this.run('UPDATE events SET reminder_sent=1 WHERE id=? AND reminder_sent=0', id); }
  async getHealth() {
    await this.first('SELECT 1 AS ok');
    await this.first('SELECT message_id FROM inbox LIMIT 1');
    await this.first('SELECT id FROM outbox LIMIT 1');
    await this.first('SELECT phone FROM sessions LIMIT 1');
    await this.first('SELECT key FROM settings LIMIT 1');
    await this.first('SELECT id FROM handoffs LIMIT 1');
    await this.first('SELECT record_id FROM simulation_records LIMIT 1');
    return { database: 'ok', schema: 'ok' };
  }
}
