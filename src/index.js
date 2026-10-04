import { config, normalizePhone } from './config.js';
import { Store } from './store.js';
import { validWebhookSignature, adminAuthorized, adminCookie, configured } from './security.js';
export { RestaurantCoordinator } from './coordinator.js';

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }

async function readBytes(request, limit) {
  if (Number(request.headers.get('content-length') || 0) > limit) throw new RangeError('Payload excessivo');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new RangeError('Payload excessivo'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function incoming(request, env, ctx) {
  if (!configured(env.WHATSAPP_APP_SECRET) || !/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID || '') || !env.INCOMING_QUEUE) return json({ error: 'Configure os segredos e a fila.' }, 503);
  const raw = await readBytes(request, 1048576);
  if (!await validWebhookSignature(raw, request.headers.get('x-hub-signature-256'), env.WHATSAPP_APP_SECRET)) return json({ error: 'Assinatura inválida.' }, 401);
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); }
  catch { return json({ error: 'JSON inválido.' }, 400); }
  if (payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) return json({ error: 'Webhook inválido.' }, 400);
  const jobs = [];
  const store = new Store(env.DB);
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (change.field !== 'messages') continue;
      if (String(value.metadata?.phone_number_id || '') !== String(env.WHATSAPP_PHONE_NUMBER_ID)) return json({ error: 'Número não autorizado.' }, 403);
      for (const status of change.value?.statuses || []) {
        if (status.id && ['sent', 'delivered', 'read', 'failed'].includes(status.status)) jobs.push({ body: { type: 'delivery_status', externalId: status.id, status: status.status, errorCode: status.errors?.[0]?.code || null }, contentType: 'json' });
      }
      for (const message of value.messages || []) {
        const phone = normalizePhone(message.from);
        if (!message.id || !/^\d{8,15}$/.test(phone) || !/^\d+$/.test(String(message.timestamp || ''))) return json({ error: 'Mensagem inválida.' }, 400);
        const name = value.contacts?.find(contact => normalizePhone(contact.wa_id) === phone)?.profile?.name || '';
        const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
        jobs.push({ body: { id: message.id, phone, name: String(name).slice(0, 80), text: String(text).slice(0, 4096), type: message.type || 'text', timestamp: message.timestamp }, contentType: 'json' });
      }
    }
  }
  // Register every signed message before enqueueing. The coordinator can then
  // preserve receipt order even if Queues delivers jobs out of order.
  for (const job of jobs) if (job.body.id) await store.receiveMessage(job.body.id, job.body.phone, job.body);
  for (let offset = 0; offset < jobs.length; offset += 50) await env.INCOMING_QUEUE.sendBatch(jobs.slice(offset, offset + 50));
  return json({ ok: true });
}

async function admin(request, env) {
  const c = config(env);
  if (!await adminAuthorized(request, env)) return loginPage('/admin');
  const data = await new Store(env.DB).dashboard();
  const orders = data.orders || [];
  const reservations = [...(data.reservations || [])].sort((a, b) => reservationTimestamp(a) - reservationTimestamp(b));
  const waitlist = data.waitlist || [];
  const incidents = data.incidents || [];
  const logs = data.logs || [];
  const handoffs = data.handoffs || [];
  const notifications = data.notifications || [];
  const events = data.events || [];
  const waitingPeople = waitlist.filter(item => item.status === 'waiting').reduce((sum, item) => sum + Number(item.guests || 0), 0);
  const activeReservations = reservations.filter(item => ['pending', 'confirmed'].includes(item.status)).length;
  const orderRows = orders.map(order => `<tr><td><strong>#${escapeHtml(order.id)}</strong><small>${formatDateTime(order.created_at, c.timezone)}</small></td><td>${renderOrderItems(order.items)}</td><td>${escapeHtml(order.address || 'Não informado')}</td><td>${formatMoney(order.total)}</td><td>${escapeHtml(paymentLabel(order.payment_method))}</td><td>${statusBadge(order.status)}</td><td>${order.eta_minutes ? `${escapeHtml(order.eta_minutes)} min` : '—'}</td></tr>`).join('');
  const reservationRows = reservations.map(item => `<tr><td><strong>${escapeHtml(item.date)}</strong><small>${escapeHtml(item.time)}</small></td><td>#${escapeHtml(item.id)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.phone)}</td><td>${escapeHtml(item.guests)}</td><td>${statusBadge(item.status)}</td><td>${escapeHtml(item.notes || '—')}</td></tr>`).join('');
  const waitlistRows = waitlist.map((item, index) => `<tr><td><strong>#${escapeHtml(item.id)}</strong><small>${index + 1}º · ${escapeHtml(item.status)}</small></td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.phone)}</td><td>${escapeHtml(item.guests)}</td><td>${formatDateTime(item.created_at, c.timezone)}</td></tr>`).join('');
  const handoffRows = handoffs.map(item => `<tr><td>#${escapeHtml(item.id)}</td><td>${escapeHtml(item.name)}<small>${escapeHtml(item.phone)}</small></td><td>${statusBadge(item.status)}</td><td style="white-space:pre-wrap">${escapeHtml(item.text)}</td><td>assumir ${escapeHtml(item.id)}<br>responder ${escapeHtml(item.id)} mensagem<br>concluir ${escapeHtml(item.id)}</td></tr>`).join('');
  const notificationRows = notifications.map(item => `<tr><td>#${escapeHtml(item.id)}</td><td>${escapeHtml(item.destination)}</td><td>${escapeHtml(item.kind)}</td><td>${statusBadge(item.status)}<small>${escapeHtml(item.delivery_status || 'Sem confirmação')}</small></td><td>${escapeHtml(item.attempts)}</td><td>${escapeHtml(item.last_error || 'Aguardando envio')}</td></tr>`).join('');
  const eventRows = events.map(item => `<tr><td>#${escapeHtml(item.id)}</td><td>${escapeHtml(item.name)}<small>${escapeHtml(item.phone)}</small></td><td>${formatDateTime(item.event_date, c.timezone)}</td><td>${escapeHtml(item.guests)}</td><td>${escapeHtml(item.details || '—')}</td></tr>`).join('');
  const incidentRows = incidents.map(item => `<tr><td>#${escapeHtml(item.id)}</td><td>${escapeHtml(item.severity)}</td><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.responsible || 'Não definido')}</td><td>${formatDateTime(item.created_at, c.timezone)}</td></tr>`).join('');
  const logRows = logs.map(item => `<tr><td>${formatDateTime(item.created_at, c.timezone)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.details || '—')}</td><td>${escapeHtml(item.actor_phone)}</td></tr>`).join('');
  return new Response(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(c.name)} — Painel</title>
<style>
:root{--green:#075e54;--green2:#128c7e;--cream:#f7f5f0;--ink:#17202a;--muted:#65727d;--line:#e3e7e8;--card:#fff}*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font:14px system-ui,sans-serif}header{background:linear-gradient(120deg,var(--green),var(--green2));color:white;padding:24px max(20px,calc((100% - 1280px)/2))}header h1{margin:0;font-size:25px}header p{margin:5px 0 0;opacity:.82}.layout{max-width:1280px;margin:auto;padding:20px}.nav{display:flex;gap:8px;overflow:auto;margin-bottom:18px}.nav a{white-space:nowrap;text-decoration:none;color:var(--green);background:white;border:1px solid var(--line);padding:9px 13px;border-radius:20px;font-weight:650}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px}.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:17px;box-shadow:0 3px 12px #00000008}.stat span{display:block;color:var(--muted);font-size:12px}.stat strong{display:block;font-size:27px;margin-top:4px;color:var(--green)}section{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:16px 0;overflow:hidden;box-shadow:0 3px 12px #00000008}section h2{font-size:18px;margin:0;padding:17px 18px;border-bottom:1px solid var(--line)}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:760px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:#fafbfb}th,td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}td small{display:block;color:var(--muted);margin-top:4px}.items{margin:0;padding-left:17px}.items li+li{margin-top:3px}.badge{display:inline-block;padding:4px 8px;border-radius:12px;background:#eef1f2;font-size:12px;font-weight:650}.received,.pending{background:#fff3cd;color:#795d00}.preparing{background:#dbeafe;color:#174c8c}.ready,.confirmed{background:#d1fae5;color:#166534}.out_for_delivery{background:#ede9fe;color:#5b21b6}.delivered{background:#dcfce7;color:#166534}.cancelled{background:#fee2e2;color:#991b1b}.empty{padding:22px;color:var(--muted);text-align:center}.updated{color:var(--muted);font-size:12px;text-align:right;margin-top:14px}@media(max-width:760px){.stats{grid-template-columns:repeat(2,1fr)}header{padding:20px}.layout{padding:14px}.stat strong{font-size:23px}}
</style></head><body>
<header><h1>${escapeHtml(c.name)}</h1><p>Painel operacional</p></header><main class="layout">
<nav class="nav"><a href="#pedidos">Pedidos</a><a href="#reservas">Agenda de reservas</a><a href="#espera">Lista de espera</a><a href="#atendimentos">Atendimentos</a><a href="#avisos">Avisos pendentes</a><a href="#eventos">Eventos</a><a href="#ocorrencias">Ocorrências</a><a href="#registros">Registros</a></nav>
<div class="stats"><div class="stat"><span>Pedidos recentes</span><strong>${orders.length}</strong></div><div class="stat"><span>Reservas ativas</span><strong>${activeReservations}</strong></div><div class="stat"><span>Pessoas na espera</span><strong>${waitingPeople}</strong></div></div>
<section id="pedidos"><h2>Pedidos recentes</h2>${orderRows ? `<div class="table"><table><thead><tr><th>Pedido e horário</th><th>Itens</th><th>Entrega</th><th>Total</th><th>Pagamento</th><th>Status</th><th>Previsão</th></tr></thead><tbody>${orderRows}</tbody></table></div>` : emptyState('Nenhum pedido registrado.')}</section>
<section id="reservas"><h2>Agenda de reservas</h2>${reservationRows ? `<div class="table"><table><thead><tr><th>Data e horário</th><th>Reserva</th><th>Nome</th><th>Telefone</th><th>Pessoas</th><th>Status</th><th>Observações</th></tr></thead><tbody>${reservationRows}</tbody></table></div>` : emptyState('Nenhuma reserva registrada.')}</section>
<section id="espera"><h2>Lista de espera</h2>${waitlistRows ? `<div class="table"><table><thead><tr><th>Posição</th><th>Nome</th><th>Telefone</th><th>Pessoas</th><th>Entrada</th></tr></thead><tbody>${waitlistRows}</tbody></table></div>` : emptyState('A lista de espera está vazia.')}</section>
<section id="ocorrencias"><h2>Ocorrências abertas</h2>${incidentRows ? `<div class="table"><table><thead><tr><th>Número</th><th>Gravidade</th><th>Descrição</th><th>Responsável</th><th>Registro</th></tr></thead><tbody>${incidentRows}</tbody></table></div>` : emptyState('Nenhuma ocorrência aberta.')}</section>
<section id="registros"><h2>Registros da equipe e do atendimento</h2>${logRows ? `<div class="table"><table><thead><tr><th>Horário</th><th>Ação</th><th>Detalhes</th><th>Telefone</th></tr></thead><tbody>${logRows}</tbody></table></div>` : emptyState('Nenhum registro disponível.')}</section>
<section id="atendimentos"><h2>Atendimentos humanos</h2><p style="padding:0 18px">Envie os comandos pelo WhatsApp de um integrante autorizado da equipe.</p>${handoffRows ? `<div class="table"><table><thead><tr><th>Número</th><th>Cliente</th><th>Status</th><th>Mensagens recebidas</th><th>Comandos</th></tr></thead><tbody>${handoffRows}</tbody></table></div>` : emptyState('Nenhuma solicitação aberta.')}</section>
<section id="avisos"><h2>Avisos pendentes e falhas</h2><p style="padding:0 18px">Após cinco falhas, confira o erro e avise o destinatário manualmente. Aceite pela API não confirma entrega.</p>${notificationRows ? `<div class="table"><table><thead><tr><th>Número</th><th>Destinatário</th><th>Tipo</th><th>Situação</th><th>Tentativas</th><th>Detalhes</th></tr></thead><tbody>${notificationRows}</tbody></table></div>` : emptyState('Nenhum aviso pendente ou com falha.')}</section>
<section id="eventos"><h2>Solicitações de evento</h2>${eventRows ? `<div class="table"><table><thead><tr><th>Número</th><th>Cliente</th><th>Data</th><th>Pessoas</th><th>Detalhes</th></tr></thead><tbody>${eventRows}</tbody></table></div>` : emptyState('Nenhum evento registrado.')}</section>
<p class="updated">Atualizado em ${new Date().toLocaleString('pt-BR', { timeZone: c.timezone })}</p></main></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch])); }
function emptyState(message) { return `<div class="empty">${escapeHtml(message)}</div>`; }
function formatMoney(value) { return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function formatDateTime(value, timeZone = 'America/Sao_Paulo') {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? escapeHtml(value) : escapeHtml(date.toLocaleString('pt-BR', { timeZone, dateStyle: 'short', timeStyle: 'short' }));
}
function reservationTimestamp(item) {
  const match = `${item.date || ''} ${item.time || ''}`.match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/);
  return match ? Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5])) : Number.MAX_SAFE_INTEGER;
}
function renderOrderItems(raw) {
  try {
    const items = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(items) || !items.length) return '—';
    return `<ul class="items">${items.map(item => `<li>${escapeHtml(item.quantity || 1)}x ${escapeHtml(item.name || 'Item')}${item.details ? `<small>${escapeHtml(item.details)}</small>` : ''}${item.customization ? `<small><strong>Alterações:</strong> ${escapeHtml(item.customization)}</small>` : ''}</li>`).join('')}</ul>`;
  } catch { return escapeHtml(raw || '—'); }
}
function paymentLabel(value) { return ({ pix_pending: 'PIX aguardando', pix: 'PIX', card: 'Cartão', credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito', cash: 'Dinheiro' }[value] || value || 'Não informado'); }
function statusBadge(value) {
  const labels = { received: 'Recebido', preparing: 'Em preparo', ready: 'Pronto', out_for_delivery: 'Saiu para entrega', delivered: 'Concluído', pending: 'Pendente', confirmed: 'Confirmada', cancelled: 'Cancelada', waiting: 'Aguardando', open: 'Aberta', assigned: 'Em atendimento', resolved: 'Concluído', failed: 'Falhou', sent: 'Aceito pela API' };
  const safeClass = Object.hasOwn(labels, value) ? value : '';
  return `<span class="badge ${safeClass}">${escapeHtml(labels[value] || value || '—')}</span>`;
}

function loginPage(next) {
  return new Response(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acesso da equipe</title><style>body{font:16px system-ui;max-width:440px;margin:12vh auto;padding:24px}input,button{box-sizing:border-box;width:100%;padding:12px;margin-top:12px}button{background:#075e54;color:#fff;border:0;border-radius:6px}</style><h1>Acesso da equipe</h1><form id="login"><label>Token de acesso<input id="token" type="password" autocomplete="current-password" required></label><button>Entrar</button><p id="error" role="alert"></p></form><script>document.querySelector('#login').onsubmit=async event=>{event.preventDefault();try{const response=await fetch('/admin/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:document.querySelector('#token').value})});document.querySelector('#token').value='';if(response.ok)location.replace('${next}');else document.querySelector('#error').textContent='Acesso inválido ou não configurado.';}catch{document.querySelector('#error').textContent='Não foi possível conectar.';}};</script></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}

async function login(request, env) {
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Origem inválida', { status: 403 });
  let data;
  const raw = await readBytes(request, 1024);
  try { data = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: 'JSON inválido.' }, 400); }
  const auth = new Request(request.url, { headers: { 'x-admin-token': String(data.token || '') } });
  if (!await adminAuthorized(auth, env)) return new Response('Não autorizado', { status: 401 });
  return new Response(null, { status: 204, headers: { 'set-cookie': await adminCookie(env), 'cache-control': 'no-store' } });
}

async function simulator(request, env) {
  if (env.SIMULATOR_ENABLED !== 'true') return new Response('Simulador desabilitado', { status: 404 });
  if (!await adminAuthorized(request, env)) return request.method === 'GET' ? loginPage('/simulator') : new Response('Não autorizado', { status: 401 });
  if (request.method === 'POST') {
    if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return new Response('Origem inválida', { status: 403 });
    let body;
    const raw = await readBytes(request, 8192);
    try { body = JSON.parse(new TextDecoder().decode(raw)); }
    catch { return json({ error: 'Mensagem inválida.' }, 400); }
    const text = String(body.text || '').trim();
    const phone = String(body.session || '');
    const name = String(body.name || 'Cliente').trim().slice(0, 80) || 'Cliente';
    if (!/^99\d{11}$/.test(phone)) return json({ error: 'Sessão inválida. Inicie uma nova conversa.' }, 400);
    if (!text || text.length > 1000) return json({ error: 'Digite uma mensagem com até 1.000 caracteres.' }, 400);
    try {
      return await coordinator(env).fetch('https://coordinator/message', { method: 'POST', body: JSON.stringify({ id: `sim:${crypto.randomUUID()}`, phone, text, name, type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), simulated: true }) });
    } catch (error) {
      console.error('Erro no simulador:', error.name || 'Error');
      return json({ error: 'Não foi possível processar a mensagem.' }, 500);
    }
  }
  if (request.method !== 'GET') return new Response('Método não permitido', { status: 405 });
  const businessName = escapeHtml(config(env).name);
  return new Response(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Simulador — ${businessName}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#efeae2;font:15px system-ui,sans-serif;color:#17202a}.app{max-width:720px;height:100vh;margin:auto;display:flex;flex-direction:column;background:#f7f3ee;box-shadow:0 0 30px #0002}.top{padding:16px 20px;background:#075e54;color:white;display:flex;align-items:center;justify-content:space-between}.top strong{font-size:17px}.top small{display:block;opacity:.8;margin-top:2px}.top button{border:1px solid #ffffff80;background:transparent;color:white;border-radius:18px;padding:8px 12px;cursor:pointer}.chat{flex:1;overflow:auto;padding:20px;display:flex;flex-direction:column;gap:10px;background-image:linear-gradient(#ffffff55,#ffffff55)}.bubble{max-width:82%;padding:10px 12px;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere;box-shadow:0 1px 2px #0002}.bot{align-self:flex-start;background:white}.user{align-self:flex-end;background:#d9fdd3}.status{text-align:center;color:#667;font-size:12px}.send{display:flex;gap:8px;padding:12px;background:#f0f2f5}.send input{flex:1;border:0;border-radius:22px;padding:12px 16px;font:inherit;outline:none}.send button{border:0;border-radius:22px;padding:0 18px;background:#00a884;color:white;font-weight:700;cursor:pointer}.send button:disabled{opacity:.5}
</style></head><body><main class="app"><header class="top"><div><strong>${businessName}</strong><small>Simulador — não envia ao WhatsApp</small></div><button id="reset">Nova conversa</button></header><section id="chat" class="chat"></section><form id="form" class="send"><input id="message" maxlength="1000" autocomplete="off" placeholder="Digite uma mensagem"><button>Enviar</button></form></main>
<script>
const chat=document.querySelector('#chat'),form=document.querySelector('#form'),input=document.querySelector('#message'),send=form.querySelector('button');
let session;
function newSession(){session='99'+String(Date.now()).slice(-8)+String(Math.floor(Math.random()*1000)).padStart(3,'0');localStorage.setItem('simulator-session',session);chat.replaceChildren();}
function bubble(text,type){const el=document.createElement('div');el.className='bubble '+type;el.textContent=text;chat.append(el);chat.scrollTop=chat.scrollHeight;}
async function talk(text,showUser=true){if(showUser)bubble(text,'user');send.disabled=true;input.disabled=true;try{const response=await fetch('/simulator',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text,session,name:'Cliente teste'})});if(response.status===401){location.replace('/simulator');return;}const data=await response.json();bubble(data.reply||data.error||(response.ok?'Sem resposta':'Erro ao conversar com o bot.'),'bot');}catch{bubble('Não foi possível conectar ao simulador.','bot');}finally{send.disabled=false;input.disabled=false;input.focus();}}
form.addEventListener('submit',event=>{event.preventDefault();const text=input.value.trim();if(!text)return;input.value='';talk(text);});
document.querySelector('#reset').addEventListener('click',()=>{newSession();talk('oi',false);});
newSession();
bubble('Este chat usa a lógica real do bot, sem acessar a API do WhatsApp.','status');talk('oi',false);
</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function privacyPage(env) {
  return new Response(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Política de Privacidade - Chatbot Restaurante</title>
<style>body{font:16px system-ui,sans-serif;line-height:1.55;max-width:820px;margin:2rem auto;padding:0 1rem;color:#17202a}h1{color:#075e54}h2{margin-top:1.8rem}</style>
</head>
<body>
<h1>Política de Privacidade — Chatbot Restaurante</h1>
<p>Última atualização: 4 de outubro de 2026</p>
<p>Esta política explica como o Chatbot Restaurante trata as informações enviadas pelo WhatsApp quando você conversa com o atendimento.</p>
<h2>Informações recebidas</h2>
<p>Podemos receber seu número de telefone, nome exibido no WhatsApp e o conteúdo das mensagens que você envia. Usamos essas informações somente para responder dúvidas, consultar o cardápio e registrar ou administrar pedidos e reservas solicitados por você.</p>
<h2>Compartilhamento</h2>
<p>As mensagens são processadas pela Plataforma WhatsApp Business da Meta e armazenadas na infraestrutura Cloudflare para permitir a comunicação e o atendimento.</p>
<h2>Armazenamento e segurança</h2>
<p>Guardamos apenas os dados necessários para prestar o atendimento e adotamos medidas razoáveis de segurança. Os dados podem ser excluídos quando deixarem de ser necessários ou mediante solicitação, salvo obrigação legal de retenção.</p>
<h2>Seus direitos</h2>
<p>Você pode solicitar acesso, correção ou exclusão dos dados relacionados ao atendimento. Contato da empresa: ${escapeHtml(env.PRIVACY_CONTACT || 'Contato ainda não configurado pela empresa.')}</p>
<h2>Alterações</h2>
<p>Esta política pode ser atualizada para refletir mudanças no serviço ou na legislação. A versão mais recente estará sempre disponível nesta página.</p>
</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function coordinator(env) {
  if (!env.COORDINATOR) throw new Error('COORDINATOR não configurado.');
  return env.COORDINATOR.get(env.COORDINATOR.idFromName('restaurant'));
}

async function readiness(env) {
  const missing = ['DB', 'INCOMING_QUEUE', 'COORDINATOR', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'ADMIN_TOKEN'].filter(key => !configured(env[key]));
  try {
    const c = config(env);
    if (!c.products.length || env.ALLOW_DEMO_CATALOG === 'true') missing.push('PRODUCTS_JSON');
    if (!c.internalNumbers.length) missing.push('INTERNAL_NUMBERS');
    if (!env.BUSINESS_NAME || /configure|seu restaurante/i.test(env.BUSINESS_NAME)) missing.push('BUSINESS_NAME');
    if (!env.ADDRESS || /configure|atualize/i.test(env.ADDRESS)) missing.push('ADDRESS');
    if (!env.OPENING_HOURS || /configure/i.test(env.OPENING_HOURS)) missing.push('OPENING_HOURS');
    if (!/^[a-z0-9_]+$/.test(env.WHATSAPP_NOTIFICATION_TEMPLATE || '')) missing.push('WHATSAPP_NOTIFICATION_TEMPLATE');
    if (!/^[a-z]{2}(?:_[A-Z]{2})?$/.test(env.WHATSAPP_TEMPLATE_LANGUAGE || '')) missing.push('WHATSAPP_TEMPLATE_LANGUAGE');
    if (!/^\d+$/.test(env.WHATSAPP_PHONE_NUMBER_ID || '')) missing.push('WHATSAPP_PHONE_NUMBER_ID');
    if (c.internalNumbers.some(phone => !/^\d{8,15}$/.test(phone))) missing.push('INTERNAL_NUMBERS');
    if (!env.PRIVACY_CONTACT || /configure|insira aqui/i.test(env.PRIVACY_CONTACT)) missing.push('PRIVACY_CONTACT');
  } catch { missing.push('CONFIG'); }
  if (env.DB) { try { await new Store(env.DB).getHealth(); } catch { missing.push('SCHEMA_D1'); } }
  return { ok: missing.length === 0, service: 'whatsapp-restaurante-bot', missing: [...new Set(missing)] };
}

export default {
  async fetch(request, env, ctx) {
    try {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/webhook') {
      if (!configured(env.WHATSAPP_VERIFY_TOKEN)) return new Response('Verificação não configurada', { status: 503 });
      if (url.searchParams.get('hub.mode') !== 'subscribe' || url.searchParams.get('hub.verify_token') !== env.WHATSAPP_VERIFY_TOKEN) return new Response('Token inválido', { status: 403 });
      return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') return await incoming(request, env, ctx);
    if (request.method === 'POST' && url.pathname === '/admin/session') return await login(request, env);
    if (request.method === 'GET' && url.pathname === '/privacy') return privacyPage(env);
    if (request.method === 'GET' && url.pathname === '/admin') return await admin(request, env);
    if (url.pathname === '/simulator') return await simulator(request, env);
    if (request.method === 'GET' && url.pathname === '/health') { const state = await readiness(env); return json(state, state.ok ? 200 : 503); }
    return new Response('Not found', { status: 404 });
    } catch (error) { if (error instanceof RangeError) return json({ error: 'Payload excessivo.' }, 413); console.error('Worker indisponível', error.name || 'Error'); return json({ error: 'Serviço indisponível. Verifique a configuração.' }, 503); }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        const response = await coordinator(env).fetch('https://coordinator/message', { method: 'POST', body: JSON.stringify(message.body) });
        if (!response.ok) throw new Error('Processamento pendente');
        message.ack();
      } catch { message.retry({ delaySeconds: 60 }); }
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const response = await coordinator(env).fetch('https://coordinator/maintenance', { method: 'POST' });
      if (!response.ok) throw new Error('Manutenção pendente.');
    })());
  }
};
