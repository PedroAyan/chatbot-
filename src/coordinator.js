import { config, normalizePhone } from './config.js';
import { Store } from './store.js';
import { handleClient, handleInternal } from './flows.js';
import { sendNotification } from './whatsapp.js';

// One coordinator per restaurant serializes clients, staff, reminders and retries.
// Business state stays in D1; the in-memory chain is only a concurrency gate.
export class RestaurantCoordinator {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; this.tail = Promise.resolve(); }

  fetch(request) {
    const run = this.tail.then(() => this.dispatch(request));
    this.tail = run.catch(() => {});
    return run;
  }

  async dispatch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/maintenance') {
        await this.reminders();
        await this.deliverNotifications();
        return Response.json({ ok: true });
      }
      if (path !== '/message') return new Response('Not found', { status: 404 });
      const event = await request.json();
      if (event.type === 'delivery_status') {
        await new Store(this.env.DB).recordDeliveryStatus(event.externalId, event.status, event.errorCode);
        return Response.json({ ok: true });
      }
      const reply = await this.processInOrder(event);
      if (!event.simulated) await this.deliverNotifications();
      return Response.json({ ok: true, reply });
    } catch (error) {
      // Never log message bodies, addresses, credentials or raw Graph API errors.
      console.error('Falha no processamento', error.name || 'Error');
      return Response.json({ error: 'Processamento indisponível; a fila tentará novamente.' }, { status: 503 });
    }
  }

  async processInOrder(event) {
    const receipt = new Store(this.env.DB);
    await receipt.receiveMessage(event.id, event.phone, event);
    const current = await receipt.first('SELECT rowid AS sequence FROM inbox WHERE message_id=?', event.id);
    const earlier = await receipt.all("SELECT payload FROM inbox WHERE phone=? AND rowid<? AND status='received' ORDER BY rowid LIMIT 20", event.phone, current.sequence);
    for (const row of earlier) await this.processMessage(JSON.parse(row.payload));
    const remaining = await receipt.first("SELECT message_id FROM inbox WHERE phone=? AND rowid<? AND status='received' LIMIT 1", event.phone, current.sequence);
    if (remaining) { await this.deliverNotifications(); throw new Error('Mensagens anteriores ainda em processamento.'); }
    return this.processMessage(event);
  }

  async processMessage(event) {
      if (!event.id || !/^\d{8,15}$/.test(event.phone || '')) throw new TypeError('Mensagem inválida');
      const timestamp = Number(event.timestamp) * 1000;
      if (!Number.isFinite(timestamp) || timestamp > Date.now() + 300000) throw new TypeError('Horário inválido');
      const store = new Store(this.env.DB, { messageId: event.id, simulated: event.simulated === true, lastSeen: new Date(timestamp).toISOString() });
      await store.receiveMessage(event.id, event.phone, event);
      const saved = await store.getMessage(event.id);
      let reply = saved.reply;
      if (saved.status === 'received') {
        const c = config(this.env);
        const kitchen = await store.getSetting('kitchen_minutes');
        if (Number.isInteger(Number(kitchen)) && Number(kitchen) > 0) c.deliveryMinutes = Number(kitchen);
        await store.saveContact(event.phone, event.name);
        if (event.type !== 'text' && !event.text) reply = 'Envie sua solicitação por texto. Para acessar o menu, envie 0.';
        else {
          const internal = !event.simulated && c.internalNumbers.includes(normalizePhone(event.phone));
          reply = internal
            ? await handleInternal({ phone: event.phone, text: event.text, store, env: this.env, c })
            : await handleClient({ phone: event.phone, text: event.text, name: event.name, store, env: this.env, c });
        }
        await store.enqueueNotification(event.phone, reply, { kind: 'reply', reference: event.id });
        reply = await store.completeMessage(reply);
      }
      if (event.simulated) await new Store(this.env.DB).markMessageSent(event.id);
      return reply;
  }

  async reminders() {
    const store = new Store(this.env.DB);
    for (const event of await store.dueEvents()) {
      await store.batch(async () => {
        await store.enqueueNotification(event.phone, `Lembrete da sua solicitação de evento para ${new Date(event.event_date).toLocaleString('pt-BR', { timeZone: config(this.env).timezone })}. O orçamento e a disponibilidade precisam ser confirmados pela equipe. Para falar com a equipe, envie 8.`, { kind: 'event_reminder', reference: String(event.id) });
        await store.markEventReminder(event.id);
      });
    }
  }

  async deliverNotifications() {
    const store = new Store(this.env.DB);
    const c = config(this.env);
    for (const notification of await store.pendingNotifications()) {
      try {
        if (!notification.to && notification.kind === 'team') {
          if (!c.internalNumbers.length) throw new Error('INTERNAL_NUMBERS não configurado.');
          await store.batch(async () => {
            for (const phone of c.internalNumbers) await store.enqueueNotification(phone, notification.text, { kind: 'team', reference: `${notification.id}:${phone}` });
            await store.markNotificationSent(notification.id);
          });
          continue;
        }
        const contact = await store.getContact(notification.to);
        const result = await sendNotification(this.env, notification.to, notification.text, { lastSeen: contact?.last_seen, kind: notification.kind });
        await store.batch(async () => {
          await store.markNotificationSent(notification.id, result?.messages?.[0]?.id);
          if (notification.kind === 'reply') await store.markMessageSent(notification.reference);
        });
      } catch (error) {
        await store.markNotificationFailed(notification.id, error.safeMessage || 'Falha no envio. Verifique credenciais, template aprovado e conectividade.');
        console.error('Aviso pendente', notification.id);
      }
    }
  }
}
