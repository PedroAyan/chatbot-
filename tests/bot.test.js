import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { RestaurantCoordinator } from '../src/index.js';
import { Store } from '../src/store.js';

// The only substitute for D1 is its interface; all queries use actual SQLite.
class D1Adapter {
  constructor(sqlite) { this.sqlite = sqlite; }
  prepare(sql) {
    const sqlite = this.sqlite;
    const statement = bindings => ({
      bind: (...values) => statement(values),
      runSync: () => {
        const result = sqlite.prepare(sql).run(...bindings);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      async run() { return this.runSync(); },
      async first() { return sqlite.prepare(sql).get(...bindings) || null; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...bindings) }; }
    });
    return statement([]);
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function localDateTime(date) {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('day')}/${value('month')}/${value('year')} ${value('hour')}:${value('minute')}`;
}

function fixture(t, { historicalEvent = false } = {}) {
  // These are deliberately fictitious destinations, never used with a real API.
  const phones = { client: '9900000000001', other: '9900000000002', team: '9900000000003' };
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  sqlite.exec(readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8'));
  if (historicalEvent) {
    sqlite.prepare('INSERT INTO events(id,phone,name,event_date,guests,details,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(42, phones.client, 'Evento histórico fictício', localDateTime(new Date(Date.now() - 48 * 3600000)), 3, '', new Date().toISOString());
  }
  sqlite.exec(readFileSync(new URL('../sql/migrations/0001-production.sql', import.meta.url), 'utf8'));
  t.after(() => sqlite.close());

  const env = {
    DB: new D1Adapter(sqlite),
    WHATSAPP_TOKEN: crypto.randomUUID(),
    WHATSAPP_APP_SECRET: crypto.randomUUID(),
    WHATSAPP_VERIFY_TOKEN: crypto.randomUUID(),
    ADMIN_TOKEN: crypto.randomUUID(),
    WHATSAPP_PHONE_NUMBER_ID: '900000000',
    WHATSAPP_NOTIFICATION_TEMPLATE: 'aviso_ficticio',
    WHATSAPP_TEMPLATE_LANGUAGE: 'pt_BR',
    INTERNAL_NUMBERS: phones.team,
    BUSINESS_NAME: 'Restaurante fictício',
    ADDRESS: 'Rua fictícia, 100',
    OPENING_HOURS: '10h às 20h',
    PIX_KEY: crypto.randomUUID(),
    PIX_RECIPIENT: 'Empresa fictícia',
    ALLOW_DEMO_CATALOG: 'true',
    DELIVERY_BASE_FEE: '6',
    DELIVERY_MINUTES: '45'
  };
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = String(input);
    assert.equal(url, `https://graph.facebook.com/v23.0/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${env.WHATSAPP_TOKEN}`);
    const payload = JSON.parse(options.body);
    assert.ok(Object.values(phones).includes(payload.to), 'API mock only accepts fictitious recipients');
    const id = `fake-meta-${crypto.randomUUID()}`;
    sent.push({ payload, id });
    return Response.json({ messaging_product: 'whatsapp', messages: [{ id }] });
  });

  const queued = [], pending = [], alarms = [];
  const ctx = { waitUntil(promise) { pending.push(promise); } };
  const state = {
    ...ctx,
    storage: { async setAlarm(at) { alarms.push(at); }, async deleteAlarm() {} },
    async blockConcurrencyWhile(callback) { return callback(); }
  };
  const coordinator = new RestaurantCoordinator(state, env);
  const stub = { fetch(input, init) { return coordinator.fetch(input instanceof Request ? input : new Request(input, init)); } };
  env.COORDINATOR = {
    idFromName(name) { assert.equal(name, 'restaurant'); return name; },
    get(id) { assert.equal(id, 'restaurant'); return stub; }
  };
  env.INCOMING_QUEUE = { async sendBatch(jobs) { queued.push(...jobs); } };

  const row = (sql, ...values) => sqlite.prepare(sql).get(...values);
  const rows = (sql, ...values) => sqlite.prepare(sql).all(...values);
  const newEvent = (text, phone = phones.client) => ({
    id: `fake-inbound-${crypto.randomUUID()}`, phone, name: 'Pessoa fictícia', text,
    type: 'text', timestamp: String(Math.floor(Date.now() / 1000))
  });
  async function submit(event) {
    const response = await stub.fetch('https://coordinator/message', { method: 'POST', body: JSON.stringify(event) });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return { reply: data.reply, event };
  }
  const message = (text, phone) => submit(newEvent(text, phone));
  const say = async (text, phone) => (await message(text, phone)).reply;
  async function postWebhook(raw, secret = env.WHATSAPP_APP_SECRET) {
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    return worker.fetch(new Request('https://bot.invalid/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` }, body: raw
    }), env, ctx);
  }
  async function consumeQueue() {
    const jobs = queued.splice(0);
    let acked = 0, retried = 0;
    await worker.queue({ messages: jobs.map(job => ({
      body: job.body, ack() { acked++; }, retry() { retried++; }
    })) }, env, ctx);
    assert.equal(retried, 0);
    assert.equal(acked, jobs.length);
    return jobs.length;
  }
  async function maintenance() {
    await worker.scheduled({}, env, ctx);
    await Promise.all(pending.splice(0));
  }
  return { env, phones, sqlite, sent, queued, row, rows, newEvent, submit, message, say, postWebhook, consumeQueue, maintenance };
}

test('grafo sem ciclo: webhook assinado, duas pessoas, buffet entregue com PIX e avisos persistidos', async t => {
  const f = fixture(t);
  const first = f.newEvent('PEDIDOS');
  const other = f.newEvent('7', f.phones.other);
  const raw = JSON.stringify({
    object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: f.env.WHATSAPP_PHONE_NUMBER_ID },
      contacts: [first, other].map(event => ({ wa_id: event.phone, profile: { name: event.name } })),
      messages: [first, other].map(event => ({ id: event.id, from: event.phone, timestamp: event.timestamp, type: 'text', text: { body: event.text } }))
    } }] }]
  }, null, 2);
  assert.equal((await f.postWebhook(raw, crypto.randomUUID())).status, 401);
  assert.equal(f.queued.length, 0);
  assert.equal((await f.postWebhook(raw)).status, 200);
  assert.equal(await f.consumeQueue(), 2);
  assert.equal(f.row('SELECT COUNT(*) AS count FROM inbox').count, 2);
  assert.equal(f.row('SELECT state FROM sessions WHERE phone=?', f.phones.client).state, 'order_food');
  assert.equal(f.row('SELECT state FROM sessions WHERE phone=?', f.phones.other).state, 'feedback');
  assert.match(await f.say('5', f.phones.other), /avaliação 5\/5/);
  await f.say('cozinha 60', f.phones.team);
  assert.equal(f.row("SELECT value FROM settings WHERE key='kitchen_minutes'").value, '60');

  await f.say('2');
  await f.say('1');
  await f.say('ACEITAR PACOTE');
  await f.say('SEM ADICIONAIS');
  await f.say('32');
  await f.say('1');
  await f.say('FINALIZAR');
  await f.say('PIX');
  await f.say('ENTREGA');
  assert.match(await f.say('Rua fictícia, 123, Centro, Cidade fictícia'), /1\.061,00/);
  assert.equal(f.row('SELECT COUNT(*) AS count FROM orders').count, 0);
  const confirmed = await f.message('CONFIRMAR');
  assert.ok(confirmed.reply.includes(f.env.PIX_KEY));
  const order = f.row('SELECT * FROM orders');
  assert.equal(order.total, 1061);
  assert.equal(order.payment_method, 'pix_pending');
  assert.equal(order.eta_minutes, 60);
  assert.equal(JSON.parse(order.items)[0].guestCount, 50);
  assert.equal(JSON.parse(order.items)[1].priceCents, 30000);

  const sentBeforeDuplicate = f.sent.length;
  assert.equal((await f.submit(confirmed.event)).reply, confirmed.reply);
  assert.equal(f.row('SELECT COUNT(*) AS count FROM orders').count, 1);
  assert.equal(f.row('SELECT COUNT(*) AS count FROM webhook_commits WHERE message_id=?', confirmed.event.id).count, 1);
  assert.equal(f.sent.length, sentBeforeDuplicate);
  for (const command of ['preparando', 'saiu', 'entregue']) {
    assert.match(await f.say(`/equipe ${command} ${order.id}`, f.phones.team), /Aviso encaminhado/);
  }
  assert.equal(f.row('SELECT status,payment_method FROM orders').status, 'delivered');
  assert.equal(f.row('SELECT status,payment_method FROM orders').payment_method, 'pix_pending');
  const notices = f.rows("SELECT * FROM outbox WHERE kind='order_status'");
  assert.equal(notices.length, 3);
  assert.ok(notices.every(notice => notice.destination === f.phones.client && notice.status === 'sent' && notice.whatsapp_message_id));
  assert.ok(notices.every(notice => f.sent.some(message => message.id === notice.whatsapp_message_id && message.payload.text.body === notice.text)));
  assert.equal(f.row("SELECT COUNT(*) AS count FROM outbox WHERE status!='sent'").count, 0);
});

test('grafo com ciclo: editar e retirar pedido, disponibilidade, atendimento, fila e lembrete de evento', async t => {
  const f = fixture(t, { historicalEvent: true });
  await f.say('esgotado 23', f.phones.team);
  await f.say('PEDIDOS');
  await f.say('2');
  await f.say('1');
  await f.say('EDITAR PACOTE');
  assert.match(await f.say('ADICIONAR 23'), /não existe nas opções/);
  assert.equal(f.row('SELECT available FROM product_availability WHERE product_id=23').available, 0);
  await f.say('disponivel 23', f.phones.team);
  assert.equal(f.row('SELECT available FROM product_availability WHERE product_id=23').available, 1);
  await f.say('ADICIONAR 22 25 22');
  await f.say('CONCLUIR EDIÇÃO');
  assert.match(await f.say('CONTINUAR'), /adicionar salgados/);
  await f.say('SEM ADICIONAIS');
  await f.say('32');
  await f.say('1');
  await f.say('FINALIZAR');
  await f.say('DINHEIRO');
  await f.say('RETIRADA');
  await f.say('EDITAR');
  assert.match(await f.say('REMOVER 32'), /1\.085,00/);
  await f.say('FINALIZAR');
  await f.say('DINHEIRO');
  assert.match(await f.say('RETIRADA'), /Taxa: R\$\s*0,00/);
  await f.say('CONFIRMAR');
  const order = f.row('SELECT * FROM orders');
  assert.equal(order.total, 1085);
  assert.equal(order.address, 'RETIRADA');
  assert.equal(order.payment_method, 'cash');
  const items = JSON.parse(order.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].components.find(item => item.name === 'Coxinhas').quantity, 300);
  assert.equal(items[0].components.find(item => item.name === 'Risoles').quantity, 200);
  for (const command of ['preparando', 'pronto', 'entregue']) await f.say(`${command} ${order.id}`, f.phones.team);
  assert.equal(f.row('SELECT status FROM orders').status, 'delivered');

  assert.match(await f.say('PEDIDOS'), /Escolha 1 tipo de buffet/);
  await f.say('1');
  await f.say('73');
  await f.say('22');
  await f.say('SEM BEBIDA');
  await f.say('esgotado 22', f.phones.team);
  assert.match(await f.say('FINALIZAR'), /ficaram indisponíveis/);
  assert.equal(f.row('SELECT COUNT(*) AS count FROM orders').count, 1);
  await f.say('disponivel 22', f.phones.team);
  await f.say('CANCELAR PEDIDO');

  await f.say('ATENDENTE');
  const ticket = f.row('SELECT * FROM handoffs');
  await f.say('Preciso confirmar os ingredientes para meu grupo.');
  assert.match(f.row('SELECT text FROM handoffs WHERE id=?', ticket.id).text, /confirmar os ingredientes/);
  await f.say(`assumir ${ticket.id}`, f.phones.team);
  assert.equal(f.row('SELECT status FROM handoffs WHERE id=?', ticket.id).status, 'assigned');
  await f.say(`responder ${ticket.id} Vamos verificar os ingredientes.`, f.phones.team);
  assert.equal(f.row("SELECT status FROM outbox WHERE kind='handoff_reply'").status, 'sent');
  await f.say(`concluir ${ticket.id}`, f.phones.team);
  assert.equal(f.row('SELECT status FROM handoffs WHERE id=?', ticket.id).status, 'resolved');
  assert.equal(f.row('SELECT state FROM sessions WHERE phone=?', f.phones.client).state, 'menu');

  await f.say('6');
  await f.say('ENTRAR NA LISTA');
  assert.match(await f.say('3'), /3 pessoas em 1 grupo/);
  const waiting = f.row('SELECT * FROM waitlist');
  await f.say(`chamar ${waiting.id}`, f.phones.team);
  assert.equal(f.row('SELECT status FROM waitlist WHERE id=?', waiting.id).status, 'called');
  await f.say(`retirar ${waiting.id}`, f.phones.team);
  assert.equal(f.row('SELECT status FROM waitlist WHERE id=?', waiting.id).status, 'removed');
  assert.equal(f.row("SELECT COUNT(*) AS count FROM outbox WHERE kind='waitlist_status' AND status='sent'").count, 2);

  await f.say('0');
  await f.say('11');
  await f.say(localDateTime(new Date(Date.now() + 12 * 3600000)));
  await f.say('10');
  await f.say('Evento fictício de aniversário');
  const event = f.row('SELECT * FROM events WHERE id!=42');
  assert.ok(event.event_date.endsWith('Z'));
  assert.ok(f.row('SELECT event_date FROM events WHERE id=42').event_date.endsWith('Z'), 'real migration normalizes historical events');
  await f.maintenance();
  assert.equal(f.row('SELECT reminder_sent FROM events WHERE id=?', event.id).reminder_sent, 1);
  assert.equal(f.row('SELECT reminder_sent FROM events WHERE id=42').reminder_sent, 0);
  const reminders = f.rows("SELECT * FROM outbox WHERE kind='event_reminder'");
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].reference, String(event.id));
  assert.equal(reminders[0].status, 'sent');
  assert.ok(f.sent.some(message => message.id === reminders[0].whatsapp_message_id && /Lembrete da sua solicitação/.test(message.payload.text.body)));
  const simulated = new Store(f.env.DB, { simulated: true });
  const simulatedId = await simulated.createEvent({ phone: '9900000000099', name: 'Simulação', date: new Date(Date.now() + 3600000).toISOString(), guests: 2 });
  await f.maintenance();
  assert.equal(f.row("SELECT COUNT(*) AS count FROM outbox WHERE kind='event_reminder' AND reference=?", String(simulatedId)).count, 0);
  assert.ok(!(await simulated.dashboard()).events.some(event => event.id === simulatedId));
  assert.equal(f.row("SELECT COUNT(*) AS count FROM outbox WHERE status!='sent'").count, 0);
});
