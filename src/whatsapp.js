const DEFAULT_API_VERSION = 'v23.0';
const TEXT_LIMIT = 4096;
const NOTIFICATION_LIMIT = 900;
const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Keep tokens, recipients, message bodies and raw API responses out of errors.
export class WhatsAppError extends Error {
  constructor(message, { retryable = false, status, code, subcode } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.safeMessage = message;
    this.retryable = retryable;
    this.status = status;
    this.code = code;
    this.subcode = subcode;
  }
}

function requiredConfiguration(env) {
  const token = String(env.WHATSAPP_TOKEN || '').trim();
  const phoneId = String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const version = String(env.WHATSAPP_API_VERSION || DEFAULT_API_VERSION).trim();
  if (!token || !phoneId || /^insira aqui$/i.test(token) || /^insira aqui$/i.test(phoneId)) {
    throw new WhatsAppError('Configure WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID antes de enviar mensagens.');
  }
  if (!/^\d+$/.test(phoneId) || !/^v\d+\.\d+$/.test(version)) {
    throw new WhatsAppError('WHATSAPP_PHONE_NUMBER_ID ou WHATSAPP_API_VERSION inválido.');
  }
  return { token, phoneId, version };
}

function recipient(to) {
  const phone = String(to || '').trim();
  if (!/^\d{7,15}$/.test(phone)) {
    throw new WhatsAppError('Destinatário inválido: use apenas dígitos, incluindo código do país e DDD.');
  }
  return phone;
}

async function api(env, payload) {
  const { token, phoneId, version } = requiredConfiguration(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', ...payload })
    });
    let result;
    try { result = await response.json(); } catch { result = null; }
    if (!response.ok) {
      const code = Number.isSafeInteger(result?.error?.code) ? result.error.code : undefined;
      const subcode = Number.isSafeInteger(result?.error?.error_subcode) ? result.error.error_subcode : undefined;
      throw new WhatsAppError(`WhatsApp recusou o envio (HTTP ${response.status}${code === undefined ? '' : `, código ${code}`}).`, {
        status: response.status,
        code,
        subcode,
        retryable: response.status === 429 || response.status >= 500 || result?.error?.is_transient === true
      });
    }
    if (!Array.isArray(result?.messages) || !result.messages[0]?.id) {
      throw new WhatsAppError('WhatsApp respondeu sem um identificador de mensagem.', { retryable: true });
    }
    return result;
  } catch (error) {
    if (error instanceof WhatsAppError) throw error;
    throw new WhatsAppError(controller.signal.aborted ? 'Tempo de envio ao WhatsApp excedido.' : 'Falha de conexão com o WhatsApp.', { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

function splitText(body) {
  if (typeof body !== 'string' || !body.trim()) throw new WhatsAppError('A mensagem de texto está vazia.');
  if (body.length > TEXT_LIMIT * 10) throw new WhatsAppError('A mensagem excede o limite de dez partes.');
  const chunks = [];
  for (let offset = 0; offset < body.length;) {
    let end = Math.min(offset + TEXT_LIMIT, body.length);
    // Keep UTF-16 surrogate pairs together at chunk boundaries.
    if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end -= 1;
    chunks.push(body.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export async function sendText(env, to, body) {
  const phone = recipient(to);
  const chunks = splitText(body);
  if (chunks.length > 10) throw new WhatsAppError('A mensagem excede o limite de dez partes.');
  const messages = [];
  for (const chunk of chunks) {
    const result = await api(env, { to: phone, type: 'text', text: { preview_url: false, body: chunk } });
    messages.push(...result.messages);
  }
  return { messaging_product: 'whatsapp', messages };
}

export function sendDocument(env, to, link, filename = 'cardapio.pdf') {
  let url;
  try { url = new URL(link); } catch { throw new WhatsAppError('URL do documento inválida.'); }
  if (url.protocol !== 'https:') throw new WhatsAppError('O documento precisa ter uma URL HTTPS pública.');
  return api(env, { to: recipient(to), type: 'document', document: { link: url.href, filename } });
}

function lastMessageTimestamp(value) {
  if (typeof value === 'number' || /^\d+$/.test(String(value || ''))) {
    const timestamp = Number(value);
    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }
  if (value instanceof Date) return value.getTime();
  const raw = String(value || '').trim();
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
}

// Only a message received from this recipient opens the 24-hour window.
// `kind` is caller metadata; it is not an API message category.
export function sendNotification(env, to, body, { lastSeen, kind } = {}) {
  if (typeof body !== 'string' || !body.trim()) throw new WhatsAppError('O aviso está vazio.');
  const seen = lastMessageTimestamp(lastSeen);
  const age = Date.now() - seen;
  if (Number.isFinite(seen) && age >= 0 && age < SERVICE_WINDOW_MS) return sendText(env, to, body);
  if (body.length > NOTIFICATION_LIMIT) throw new WhatsAppError(`Fora da janela de 24 horas: o aviso de template excede ${NOTIFICATION_LIMIT} caracteres.`);
  const name = String(env.WHATSAPP_NOTIFICATION_TEMPLATE || '').trim();
  const language = String(env.WHATSAPP_TEMPLATE_LANGUAGE || '').trim();
  if (!/^[a-z0-9_]+$/.test(name) || !/^[a-z]{2}(?:_[A-Z]{2})?$/.test(language)) {
    throw new WhatsAppError('Fora da janela de 24 horas: configure um template aprovado em WHATSAPP_NOTIFICATION_TEMPLATE e WHATSAPP_TEMPLATE_LANGUAGE.');
  }
  return api(env, {
    to: recipient(to),
    type: 'template',
    template: {
      name,
      language: { code: language },
      components: [{ type: 'body', parameters: [{ type: 'text', text: body }] }]
    }
  });
}
