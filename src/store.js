import { nowIso } from './config.js';

export class Store {
  constructor(db) { this.db = db; this.memory = new Map(); }

  async run(sql, ...bindings) {
    if (!this.db) return null;
    return this.db.prepare(sql).bind(...bindings).run();
  }
  async first(sql, ...bindings) {
    if (!this.db) return null;
    return this.db.prepare(sql).bind(...bindings).first();
  }
  async all(sql, ...bindings) {
    if (!this.db) return [];
    return (await this.db.prepare(sql).bind(...bindings).all()).results || [];
  }
  async saveContact(phone, name) {
    if (this.db) await this.run(`INSERT INTO contacts(phone,name,last_seen) VALUES(?,?,?) ON CONFLICT(phone) DO UPDATE SET name=excluded.name,last_seen=excluded.last_seen`, phone, name || '', nowIso());
  }
  async getSession(phone) {
    if (!this.db) return this.memory.get(phone) || { state: 'menu', data: {} };
    const row = await this.first('SELECT state,data FROM sessions WHERE phone=?', phone);
    return row ? { state: row.state, data: JSON.parse(row.data || '{}') } : { state: 'menu', data: {} };
  }
  async setSession(phone, state, data = {}) {
    if (!this.db) { this.memory.set(phone, { state, data }); return; }
    await this.run(`INSERT INTO sessions(phone,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(phone) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at`, phone, state, JSON.stringify(data), nowIso());
  }
  async log(phone, action, details = '') { await this.run('INSERT INTO internal_log(actor_phone,action,details,created_at) VALUES(?,?,?,?)', phone, action, details, nowIso()); }
  async createReservation(r) {
    const result = await this.run('INSERT INTO reservations(phone,name,date,time,guests,event_type,notes,created_at) VALUES(?,?,?,?,?,?,?,?)', r.phone,r.name,r.date,r.time,r.guests,r.eventType || 'mesa',r.notes || '',nowIso());
    return result?.meta?.last_row_id || Date.now();
  }
  async createOrder(o) {
    const result = await this.run('INSERT INTO orders(phone,items,total,address,payment_method,eta_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)', o.phone,JSON.stringify(o.items),o.total || 0,o.address || '',o.payment || '',o.eta || 45,nowIso(),nowIso());
    return result?.meta?.last_row_id || Date.now();
  }
  async createWaitlist(w) { await this.run('INSERT INTO waitlist(phone,name,guests,created_at) VALUES(?,?,?,?)', w.phone,w.name,w.guests,nowIso()); }
  async waitlistStatus() {
    return (await this.first("SELECT COUNT(*) AS groups_count, COALESCE(SUM(guests),0) AS people_count FROM waitlist WHERE status='waiting'")) || { groups_count: 0, people_count: 0 };
  }
  async createEvent(e) { await this.run('INSERT INTO events(phone,name,event_date,guests,details,created_at) VALUES(?,?,?,?,?,?)',e.phone,e.name,e.date,e.guests,e.details || '',nowIso()); }
  async createIncident(i) { await this.run('INSERT INTO incidents(reporter_phone,severity,description,responsible,created_at) VALUES(?,?,?,?,?)',i.phone,i.severity,i.description,i.responsible || '',nowIso()); }
  async getOrder(id) { return this.first('SELECT * FROM orders WHERE id=?', id); }
  async setOrderStatus(id, previous, status) {
    const result = await this.run('UPDATE orders SET status=?,updated_at=? WHERE id=? AND status=?', status, nowIso(), id, previous);
    return result?.meta?.changes === 1;
  }
  async listOrders(phone) { return this.all('SELECT id,status,eta_minutes,total,items,updated_at FROM orders WHERE phone=? ORDER BY id DESC LIMIT 5', phone); }
  async cancelReservation(phone, id) { return this.run("UPDATE reservations SET status='cancelled' WHERE phone=? AND id=? AND status IN ('pending','confirmed')", phone,id); }
  async updateReservation(phone, id, date, time, guests) { return this.run("UPDATE reservations SET date=?,time=?,guests=? WHERE phone=? AND id=? AND status IN ('pending','confirmed')", date,time,guests,phone,id); }
  async listReservations(phone) { return this.all("SELECT id,date,time,guests,status FROM reservations WHERE phone=? AND status IN ('pending','confirmed') ORDER BY id DESC LIMIT 5", phone); }
  async dashboard() {
    return {
      orders: await this.all('SELECT * FROM orders ORDER BY id DESC LIMIT 30'),
      reservations: await this.all('SELECT * FROM reservations ORDER BY id DESC LIMIT 30'),
      events: await this.all('SELECT * FROM events ORDER BY id DESC LIMIT 30'),
      waitlist: await this.all("SELECT * FROM waitlist WHERE status='waiting' ORDER BY id"),
      incidents: await this.all("SELECT * FROM incidents WHERE status='open' ORDER BY id DESC"),
      logs: await this.all('SELECT * FROM internal_log ORDER BY id DESC LIMIT 50')
    };
  }
  async dueEvents() {
    return this.all(`SELECT * FROM events WHERE reminder_sent=0 AND event_date <= datetime('now','+24 hours')`);
  }
  async markEventReminder(id) { await this.run('UPDATE events SET reminder_sent=1 WHERE id=?', id); }
}
