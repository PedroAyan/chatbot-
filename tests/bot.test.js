import test from 'node:test';
import assert from 'node:assert/strict';
import { handleClient, handleInternal } from '../src/flows.js';
import { config } from '../src/config.js';

function fixture() {
  const sessions = new Map();
  const orders = [];
  const c = config({ PRODUCTS_JSON: '[]', PIX_KEY: 'pix-teste', PIX_RECIPIENT: 'Empresa teste' });
  const store = {
    getSession: async phone => sessions.get(phone) || { state: 'menu', data: {} },
    setSession: async (phone, state, data = {}) => sessions.set(phone, { state, data }),
    saveContact: async () => {},
    log: async () => {},
    createOrder: async order => { orders.push({ ...order, id: orders.length + 1, status: 'received' }); return orders.length; },
    listOrders: async phone => orders.filter(o => o.phone === phone),
    getOrder: async id => orders.find(o => o.id === id),
    setOrderStatus: async (id, previous, status) => { const order = orders.find(o => o.id === id && o.status === previous); if (!order) return false; order.status = status; return true; }
  };
  const client = (text, phone = '5511000000001') => handleClient({ phone, text, name: 'Cliente', store, c });
  return { store, orders, c, client };
}

test('fluxo sem ciclo: carrinho, entrega, PIX e atualização pela equipe', async () => {
  const { store, orders, c, client } = fixture();
  assert.match(await client('pedidos'), /Buffet Festa Clássica/);
  assert.match(await client('2'), /50 convidados/);
  assert.match(await client('1'), /O que vem no pedido/);
  assert.match(await client('editar pacote'), /ITENS ATUAIS/);
  assert.match(await client('ADICIONAR 22 25 22'), /Novo total do pacote/);
  assert.match(await client('CONCLUIR EDIÇÃO'), /O que vem no pedido/);
  assert.match(await client('aceitar pacote'), /adicionar salgados/);
  assert.match(await client('sem adicionais'), /bebidas/);
  assert.match(await client('32'), /Escolha a água/);
  assert.match(await client('1'), /1\.385,00/);
  assert.match(await client('7', '5511000000002'), /1 a 5/);
  assert.match(await client('5', '5511000000002'), /avaliação 5\/5/);
  assert.match(await client('finalizar'), /Como deseja pagar/);
  assert.match(await client('pix'), /Como você quer receber/);
  assert.match(await client('entrega'), /endereço completo/);
  assert.match(await client('Rua de Teste, 123'), /1\.391,00/);
  assert.equal(orders.length, 0);
  assert.match(await client('confirmar'), /pix-teste/);
  assert.equal(orders[0].total, 1391);
  assert.equal(orders[0].payment, 'pix_pending');
  assert.equal(orders[0].items[0].guestCount, 50);
  assert.match(orders[0].items[0].details, /300 unidades de Coxinhas/);
  assert.match(orders[0].items[0].details, /200 unidades de Risoles/);
  assert.match(orders[0].items[0].details, /Mini hot dogs/);
  assert.match(await client('acompanhar pedido'), /Pedido registrado/);
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    for (const command of ['preparando', 'saiu', 'entregue']) {
      assert.match(await handleInternal({ phone: '5511000000003', text: `/equipe ${command} 1`, store, c, env: { WHATSAPP_TOKEN: 'fake', WHATSAPP_PHONE_NUMBER_ID: 'fake' } }), /Cliente avisado/);
    }
    assert.equal(sent.length, 3);
    assert.equal(sent[0].to, '5511000000001');
    assert.equal(orders[0].status, 'delivered');
    assert.equal(orders[0].payment, 'pix_pending');
  } finally { globalThis.fetch = originalFetch; }
});

test('fluxo com ciclo: editar carrinho, remover item e confirmar retirada', async () => {
  const { client, orders } = fixture();
  await client('4');
  await client('1');
  await client('73');
  assert.match(await client('21'), /número 21 não existe[\s\S]*22 — Cento de coxinhas/);
  await client('22');
  await client('32');
  await client('1');
  await client('finalizar');
  await client('dinheiro');
  await client('RETIRADA');
  await client('editar');
  assert.match(await client('remover 32'), /110,00/);
  await client('finalizar');
  await client('dinheiro');
  assert.match(await client('RETIRADA'), /Taxa: R\$\s*0,00/);
  assert.match(await client('confirmar'), /Pedido #1 registrado/);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].total, 110);
  assert.equal(orders[0].address, 'RETIRADA');
  assert.equal(orders[0].payment, 'cash');
  assert.equal(orders[0].items.length, 2);
});
