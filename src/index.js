import { config, normalizePhone } from './config.js';
import { Store } from './store.js';
import { sendText } from './whatsapp.js';
import { handleClient, handleInternal } from './flows.js';

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }

async function incoming(request, env, ctx) {
  const payload = await request.json();
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      for (const status of change.value?.statuses || []) {
        console.log('Status WhatsApp:', JSON.stringify({
          messageId: status.id,
          status: status.status,
          timestamp: status.timestamp,
          errors: (status.errors || []).map(error => ({
            code: error.code,
            title: error.title,
            message: error.message,
            details: error.error_data?.details
          }))
        }));
      }
    }
  }
  const value = payload.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  if (!message) return;
  const phone = normalizePhone(message.from);
  const name = value.contacts?.[0]?.profile?.name || '';
  const text = message.text?.body || message.button?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '';
  const c = config(env); const store = new Store(env.DB);
  const internal = c.internalNumbers.includes(phone);
  console.log('Webhook recebido:', JSON.stringify({
  phone,
  name,
  type: message.type,
  text,
  internal
}));
  ctx.waitUntil((async () => {
    try {
      const reply = internal ? await handleInternal({ phone, text, store, env, c }) : await handleClient({ phone, text, name, store, env, c });
      await sendText(env, phone, reply);
    } catch (error) {
      console.error(error); await sendText(env, phone, 'Tivemos uma instabilidade. Um atendente foi acionado.');
    }
  })());
}

async function admin(request, env) {
  const c = config(env); const url = new URL(request.url);
  const token = request.headers.get('x-admin-token') || url.searchParams.get('token');
  if (!c.adminToken || token !== c.adminToken) return new Response('Não autorizado', { status: 401 });
  const data = await new Store(env.DB).dashboard();
  const orders = data.orders || [];
  const reservations = [...(data.reservations || [])].sort((a, b) => reservationTimestamp(a) - reservationTimestamp(b));
  const waitlist = data.waitlist || [];
  const incidents = data.incidents || [];
  const logs = data.logs || [];
  const waitingPeople = waitlist.reduce((sum, item) => sum + Number(item.guests || 0), 0);
  const activeReservations = reservations.filter(item => ['pending', 'confirmed'].includes(item.status)).length;
  const orderRows = orders.map(order => `<tr><td><strong>#${escapeHtml(order.id)}</strong><small>${formatDateTime(order.created_at, c.timezone)}</small></td><td>${renderOrderItems(order.items)}</td><td>${escapeHtml(order.address || 'Não informado')}</td><td>${formatMoney(order.total)}</td><td>${escapeHtml(paymentLabel(order.payment_method))}</td><td>${statusBadge(order.status)}</td><td>${order.eta_minutes ? `${escapeHtml(order.eta_minutes)} min` : '—'}</td></tr>`).join('');
  const reservationRows = reservations.map(item => `<tr><td><strong>${escapeHtml(item.date)}</strong><small>${escapeHtml(item.time)}</small></td><td>#${escapeHtml(item.id)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.phone)}</td><td>${escapeHtml(item.guests)}</td><td>${statusBadge(item.status)}</td><td>${escapeHtml(item.notes || '—')}</td></tr>`).join('');
  const waitlistRows = waitlist.map((item, index) => `<tr><td><strong>${index + 1}º</strong></td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.phone)}</td><td>${escapeHtml(item.guests)}</td><td>${formatDateTime(item.created_at, c.timezone)}</td></tr>`).join('');
  const incidentRows = incidents.map(item => `<tr><td>#${escapeHtml(item.id)}</td><td>${escapeHtml(item.severity)}</td><td>${escapeHtml(item.description)}</td><td>${escapeHtml(item.responsible || 'Não definido')}</td><td>${formatDateTime(item.created_at, c.timezone)}</td></tr>`).join('');
  const logRows = logs.map(item => `<tr><td>${formatDateTime(item.created_at, c.timezone)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.details || '—')}</td><td>${escapeHtml(item.actor_phone)}</td></tr>`).join('');
  return new Response(`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(c.name)} — Painel</title>
<style>
:root{--green:#075e54;--green2:#128c7e;--cream:#f7f5f0;--ink:#17202a;--muted:#65727d;--line:#e3e7e8;--card:#fff}*{box-sizing:border-box}body{margin:0;background:var(--cream);color:var(--ink);font:14px system-ui,sans-serif}header{background:linear-gradient(120deg,var(--green),var(--green2));color:white;padding:24px max(20px,calc((100% - 1280px)/2))}header h1{margin:0;font-size:25px}header p{margin:5px 0 0;opacity:.82}.layout{max-width:1280px;margin:auto;padding:20px}.nav{display:flex;gap:8px;overflow:auto;margin-bottom:18px}.nav a{white-space:nowrap;text-decoration:none;color:var(--green);background:white;border:1px solid var(--line);padding:9px 13px;border-radius:20px;font-weight:650}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:22px}.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:17px;box-shadow:0 3px 12px #00000008}.stat span{display:block;color:var(--muted);font-size:12px}.stat strong{display:block;font-size:27px;margin-top:4px;color:var(--green)}section{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:16px 0;overflow:hidden;box-shadow:0 3px 12px #00000008}section h2{font-size:18px;margin:0;padding:17px 18px;border-bottom:1px solid var(--line)}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:760px}th{text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.04em;background:#fafbfb}th,td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}td small{display:block;color:var(--muted);margin-top:4px}.items{margin:0;padding-left:17px}.items li+li{margin-top:3px}.badge{display:inline-block;padding:4px 8px;border-radius:12px;background:#eef1f2;font-size:12px;font-weight:650}.received,.pending{background:#fff3cd;color:#795d00}.preparing{background:#dbeafe;color:#174c8c}.ready,.confirmed{background:#d1fae5;color:#166534}.out_for_delivery{background:#ede9fe;color:#5b21b6}.delivered{background:#dcfce7;color:#166534}.cancelled{background:#fee2e2;color:#991b1b}.empty{padding:22px;color:var(--muted);text-align:center}.updated{color:var(--muted);font-size:12px;text-align:right;margin-top:14px}@media(max-width:760px){.stats{grid-template-columns:repeat(2,1fr)}header{padding:20px}.layout{padding:14px}.stat strong{font-size:23px}}
</style></head><body>
<header><h1>${escapeHtml(c.name)}</h1><p>Painel operacional</p></header><main class="layout">
<nav class="nav"><a href="#pedidos">Pedidos</a><a href="#reservas">Agenda de reservas</a><a href="#espera">Lista de espera</a><a href="#ocorrencias">Ocorrências</a><a href="#registros">Registros</a></nav>
<div class="stats"><div class="stat"><span>Pedidos recentes</span><strong>${orders.length}</strong></div><div class="stat"><span>Reservas ativas</span><strong>${activeReservations}</strong></div><div class="stat"><span>Pessoas na espera</span><strong>${waitingPeople}</strong></div></div>
<section id="pedidos"><h2>Pedidos recentes</h2>${orderRows ? `<div class="table"><table><thead><tr><th>Pedido e horário</th><th>Itens</th><th>Entrega</th><th>Total</th><th>Pagamento</th><th>Status</th><th>Previsão</th></tr></thead><tbody>${orderRows}</tbody></table></div>` : emptyState('Nenhum pedido registrado.')}</section>
<section id="reservas"><h2>Agenda de reservas</h2>${reservationRows ? `<div class="table"><table><thead><tr><th>Data e horário</th><th>Reserva</th><th>Nome</th><th>Telefone</th><th>Pessoas</th><th>Status</th><th>Observações</th></tr></thead><tbody>${reservationRows}</tbody></table></div>` : emptyState('Nenhuma reserva registrada.')}</section>
<section id="espera"><h2>Lista de espera</h2>${waitlistRows ? `<div class="table"><table><thead><tr><th>Posição</th><th>Nome</th><th>Telefone</th><th>Pessoas</th><th>Entrada</th></tr></thead><tbody>${waitlistRows}</tbody></table></div>` : emptyState('A lista de espera está vazia.')}</section>
<section id="ocorrencias"><h2>Ocorrências abertas</h2>${incidentRows ? `<div class="table"><table><thead><tr><th>Número</th><th>Gravidade</th><th>Descrição</th><th>Responsável</th><th>Registro</th></tr></thead><tbody>${incidentRows}</tbody></table></div>` : emptyState('Nenhuma ocorrência aberta.')}</section>
<section id="registros"><h2>Registros da equipe e do atendimento</h2>${logRows ? `<div class="table"><table><thead><tr><th>Horário</th><th>Ação</th><th>Detalhes</th><th>Telefone</th></tr></thead><tbody>${logRows}</tbody></table></div>` : emptyState('Nenhum registro disponível.')}</section>
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
    return `<ul class="items">${items.map(item => `<li>${escapeHtml(item.quantity || 1)}x ${escapeHtml(item.name || 'Item')}${item.customization ? `<small><strong>Alterações:</strong> ${escapeHtml(item.customization)}</small>` : ''}</li>`).join('')}</ul>`;
  } catch { return escapeHtml(raw || '—'); }
}
function paymentLabel(value) { return ({ pix_pending: 'PIX aguardando', pix: 'PIX', card: 'Cartão', credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito', cash: 'Dinheiro' }[value] || value || 'Não informado'); }
function statusBadge(value) {
  const labels = { received: 'Recebido', preparing: 'Em preparo', ready: 'Pronto', out_for_delivery: 'Saiu para entrega', delivered: 'Concluído', pending: 'Pendente', confirmed: 'Confirmada', cancelled: 'Cancelada', waiting: 'Aguardando', open: 'Aberta' };
  const safeClass = Object.hasOwn(labels, value) ? value : '';
  return `<span class="badge ${safeClass}">${escapeHtml(labels[value] || value || '—')}</span>`;
}

function authorized(request, env) {
  const url = new URL(request.url);
  const token = request.headers.get('x-admin-token') || url.searchParams.get('token');
  return Boolean(env.ADMIN_TOKEN && token === env.ADMIN_TOKEN);
}

async function simulator(request, env) {
  if (!authorized(request, env)) return new Response('Não autorizado', { status: 401 });
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'Mensagem inválida.' }, 400); }
    const text = String(body.text || '').trim();
    const phone = String(body.session || '');
    const name = String(body.name || 'Cliente').trim().slice(0, 80) || 'Cliente';
    if (!/^99\d{11}$/.test(phone)) return json({ error: 'Sessão inválida. Inicie uma nova conversa.' }, 400);
    if (!text || text.length > 1000) return json({ error: 'Digite uma mensagem com até 1.000 caracteres.' }, 400);
    try {
      const c = config(env);
      if (!c.pixKey) { c.pixKey = 'PIX-DE-DEMONSTRAÇÃO'; c.pixRecipient = 'Empresa de demonstração'; }
      const reply = await handleClient({ phone, text, name, store: new Store(env.DB), env, c });
      return json({ reply });
    } catch (error) {
      console.error('Erro no simulador:', error);
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
const token=new URLSearchParams(location.search).get('token')||'';
let session;
function newSession(){session='99'+String(Date.now()).slice(-8)+String(Math.floor(Math.random()*1000)).padStart(3,'0');localStorage.setItem('simulator-session',session);chat.replaceChildren();}
function bubble(text,type){const el=document.createElement('div');el.className='bubble '+type;el.textContent=text;chat.append(el);chat.scrollTop=chat.scrollHeight;}
async function talk(text,showUser=true){if(showUser)bubble(text,'user');send.disabled=true;input.disabled=true;try{const response=await fetch('/simulator',{method:'POST',headers:{'content-type':'application/json','x-admin-token':token},body:JSON.stringify({text,session,name:'Cliente teste'})});const data=await response.json();bubble(data.reply||data.error||(response.ok?'Sem resposta':'Erro ao conversar com o bot.'),'bot');}catch{bubble('Não foi possível conectar ao simulador.','bot');}finally{send.disabled=false;input.disabled=false;input.focus();}}
form.addEventListener('submit',event=>{event.preventDefault();const text=input.value.trim();if(!text)return;input.value='';talk(text);});
document.querySelector('#reset').addEventListener('click',()=>{newSession();talk('oi',false);});
newSession();
bubble('Este chat usa a lógica real do bot, sem acessar a API do WhatsApp.','status');talk('oi',false);
</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function privacyPage() {
  return new Response(`<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Política de Privacidade - Chatbot Restaurante</title>
<style>body{font:16px system-ui,sans-serif;line-height:1.55;max-width:820px;margin:2rem auto;padding:0 1rem;color:#17202a}h1{color:#075e54}h2{margin-top:1.8rem}</style>
</head>
<body>
<h1>Política de Privacidade — Chatbot Restaurante</h1>
<p>Última atualização: 16 de setembro de 2026</p>
<p>Esta política explica como o Chatbot Restaurante trata as informações enviadas pelo WhatsApp quando você conversa com o atendimento.</p>
<h2>Informações recebidas</h2>
<p>Podemos receber seu número de telefone, nome exibido no WhatsApp e o conteúdo das mensagens que você envia. Usamos essas informações somente para responder dúvidas, consultar o cardápio e registrar ou administrar pedidos e reservas solicitados por você.</p>
<h2>Compartilhamento</h2>
<p>As mensagens são processadas pela Plataforma WhatsApp Business da Meta para permitir a comunicação. Não vendemos suas informações nem as usamos para publicidade.</p>
<h2>Armazenamento e segurança</h2>
<p>Guardamos apenas os dados necessários para prestar o atendimento e adotamos medidas razoáveis de segurança. Os dados podem ser excluídos quando deixarem de ser necessários ou mediante solicitação, salvo obrigação legal de retenção.</p>
<h2>Seus direitos</h2>
<p>Você pode solicitar acesso, correção ou exclusão dos dados relacionados ao atendimento. Para isso, entre em contato pelo e-mail <a href="mailto:ayan444871@gmail.com">ayan444871@gmail.com</a>.</p>
<h2>Alterações</h2>
<p>Esta política pode ser atualizada para refletir mudanças no serviço ou na legislação. A versão mais recente estará sempre disponível nesta página.</p>
</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function reminders(env) {
  const store = new Store(env.DB); const due = await store.dueEvents();
  for (const event of due) { await sendText(env, event.phone, `Lembrete: seu evento "${event.name}" está marcado para ${event.event_date}. Responda CONFIRMAR ou ALTERAR.`); await store.markEventReminder(event.id); }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/webhook') {
      const c = config(env);
      if (url.searchParams.get('hub.verify_token') !== c.verifyToken) return new Response('Token inválido', { status: 403 });
      return new Response(url.searchParams.get('hub.challenge') || '', { status: 200 });
    }
    if (request.method === 'POST' && url.pathname === '/webhook') { await incoming(request, env, ctx); return json({ ok: true }); }
    if (request.method === 'GET' && url.pathname === '/privacy') return privacyPage();
    if (request.method === 'GET' && url.pathname === '/admin') return admin(request, env);
    if (url.pathname === '/simulator') return simulator(request, env);
    if (url.pathname === '/health') return json({ ok: true, service: 'whatsapp-restaurante-bot' });
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(reminders(env)); }
};
