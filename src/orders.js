import { sendText } from './whatsapp.js';

const money = cents => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const orderStatus = status => ({ received: 'Pedido registrado', preparing: 'Em preparo', ready: 'Pronto para retirada', out_for_delivery: 'Saiu para entrega', delivered: 'Concluído' }[status] || status);
const total = items => items.reduce((sum, p) => sum + p.priceCents * p.quantity, 0);
const summary = items => items.map(p => `${p.quantity}x ${p.name} — ${money(p.priceCents * p.quantity)}${p.details ? `\n   Inclui: ${p.details}` : ''}${p.customization ? `\n   Alterações solicitadas: ${p.customization}` : ''}`).join('\n');
const productsByCategory = (c, category) => c.products.filter(product => (product.category || 'food') === category);
const optionText = option => typeof option === 'string' ? option : option?.label || '';
const productLines = products => products.map(product => `${product.id} — ${product.name}: ${product.customOrder ? 'escolha os itens nas próximas etapas' : product.package ? `a partir de ${money(product.priceCents)}` : money(product.priceCents)}`).join('\n');
const foodCatalog = c => `🎉 Escolha 1 tipo de buffet:\n${productLines(productsByCategory(c, 'food'))}\n\nDepois você escolherá um pacote completo para 50, 100, 200, 500 ou 1.000 convidados. O preço mostrado será o total do pacote, e não a quantidade de itens.\nOs valores são estimativas e serão confirmados pela equipe.\nEnvie CANCELAR PEDIDO para sair.`;
const addonCatalog = c => {
  const products = productsByCategory(c, 'addon');
  const firstId = products[0]?.id || 22;
  return `🥟 Deseja adicionar salgados por cento?\n${productLines(products)}\n\nCada unidade da lista corresponde a 100 salgados. Exemplo: ${firstId} = 100 coxinhas; 2x${firstId} = 200 coxinhas.\nVocê também pode enviar vários códigos separados por espaço, como: ${firstId} ${firstId + 1} ${firstId + 2}.\nEnvie os números ou SEM ADICIONAIS para continuar.`;
};
const drinkCatalog = c => `🥤 Agora escolha as bebidas:\n${productLines(productsByCategory(c, 'drink'))}\n\nO valor será calculado para a quantidade de convidados do buffet.\nEnvie os números das bebidas ou SEM BEBIDA para continuar.`;
const paymentQuestion = () => `Como deseja pagar?\n\n1 — DINHEIRO\n2 — PIX\n3 — CARTÃO DE CRÉDITO\n4 — CARTÃO DE DÉBITO\n\nResponda com o número ou a forma de pagamento.`;
const paymentLabel = payment => ({ cash: 'Dinheiro', pix_pending: 'PIX', credit_card: 'Cartão de crédito', debit_card: 'Cartão de débito' }[payment] || payment);
const cartReply = items => `🛒 Seu carrinho:\n${summary(items)}\nSubtotal: ${money(total(items))}\nEnvie REMOVER seguido do número do produto, FINALIZAR ou CANCELAR PEDIDO.`;
function selectionParts(value) {
  const pastedItem = value.match(/^(\d+)\s*[—-]\s+.+/);
  if (pastedItem) return [pastedItem[1]];
  if (/^\d+(?:\s+\d+)+$/.test(value)) return value.split(/\s+/);
  return value.split(/\s*(?:,|\be\b)\s*/);
}
const validSelection = value => selectionParts(value).every(part => /^(?:(\d+)\s*x\s*)?(\d+)$/.test(part.trim()));
const compositionNames = product => product.composition?.length ? `📋 O pacote contém:\n${product.composition.map(item => `• ${item.name}`).join('\n')}\n\nAs quantidades totais serão calculadas após você escolher o número de convidados.\n\n` : product.description ? `${product.description}\n\n` : '';
const optionQuestion = (product, quantity) => `${compositionNames(product)}${product.optionLabel || `Escolha uma opção para ${product.name}`} (${quantity}x):\n${product.options.map((option, index) => `${index + 1} — ${optionText(option)}`).join('\n')}\n\nResponda com o número ou o nome da opção.`;
const guestCountFrom = items => items.find(item => Number.isSafeInteger(item.guestCount))?.guestCount || 0;
function packageDetails(product, guestCount) {
  if (!product.composition?.length || !guestCount) return product.description || '';
  return packageQuote(product, guestCount).components.map(item => `${item.amountLabel} de ${item.name} — ${money(item.priceCents)}`).join('\n• ');
}
function customPackageOption(product, guestCount) {
  if (product.customOrder) return { label: `Pedido personalizado para ${guestCount} convidados`, guestCount, priceCents: 0 };
  const quote = packageQuote(product, guestCount);
  return { label: `Pacote para ${guestCount} convidados — total dos itens: ${money(quote.totalCents)}`, guestCount, priceCents: quote.totalCents };
}
function packageQuote(product, guestCount) {
  const components = (product.composition || []).map((item, index) => {
    const amount = item.perGuest * guestCount;
    const quantity = item.unit === 'gramas' ? amount : Math.ceil(amount);
    const priceCents = item.unit === 'gramas'
      ? Math.round((amount / 1000) * item.pricePerKgCents)
      : Math.round((quantity / 100) * item.pricePerHundredCents);
    const amountLabel = item.unit === 'gramas'
      ? amount >= 1000 ? `${(amount / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kg` : `${amount.toLocaleString('pt-BR')} g`
      : `${quantity.toLocaleString('pt-BR')} unidades`;
    return { index: index + 1, name: item.name, amountLabel, quantity, unit: item.unit, priceCents };
  });
  return { components, totalCents: components.reduce((sum, item) => sum + item.priceCents, 0) };
}
function addProduct(items, product, quantity, option = '') {
  const label = optionText(option);
  const guests = guestCountFrom(items);
  if (option && typeof option === 'object' && option.pricePerGuestCents && !guests) return 'Escolha primeiro o buffet e a quantidade de convidados.';
  let priceCents = option && typeof option === 'object'
    ? option.priceCents || option.pricePerGuestCents * guests || product.priceCents
    : product.priceCents;
  const packageGuests = option?.guestCount || guests;
  const quote = product.composition?.length && packageGuests ? packageQuote(product, packageGuests) : null;
  if (quote) priceCents = quote.totalCents;
  const existing = items.find(item => item.id === product.id && (item.option || '') === label);
  if ((existing?.quantity || 0) + quantity > 99) return 'O limite é de 99 unidades por item e opção.';
  if (existing) existing.quantity += quantity;
  else {
    const details = packageDetails(product, packageGuests);
    items.push({ id: product.id, name: label ? `${product.name} (${label})` : product.name, priceCents, quantity, option: label, category: product.category, package: Boolean(product.package), perGuest: Boolean(option?.pricePerGuestCents), ...(quote ? { components: quote.components } : {}), ...(details ? { details: `• ${details}` } : {}), ...(option?.guestCount ? { guestCount: option.guestCount } : {}) });
  }
  return null;
}

function collectSelections(value, items, c, category = null) {
  const pending = [];
  let packageSelected = items.some(item => item.package);
  for (const part of selectionParts(value)) {
    const match = part.trim().match(/^(?:(\d+)\s*x\s*)?(\d+)$/);
    if (!match) return { error: 'Use apenas os números dos produtos. Exemplo: 1 3 6 ou 2x1.' };
    const quantity = Number(match[1] || 1);
    const product = c.products.find(item => item.id === Number(match[2]));
    if (!product || quantity < 1 || quantity > 99 || (category && (product.category || 'food') !== category)) {
      return { error: `O número ${match[2]} não existe nesta etapa. Veja abaixo os números disponíveis.` };
    }
    if (product.package && (quantity !== 1 || packageSelected)) return { error: 'Escolha apenas 1 pacote de buffet. A quantidade de convidados será escolhida na próxima etapa.' };
    if (product.package) packageSelected = true;
    if (product.options?.length) pending.push({ id: product.id, quantity });
    else {
      const error = addProduct(items, product, quantity);
      if (error) return { error };
    }
  }
  if (!Number.isSafeInteger(total(items))) return { error: 'O valor do carrinho ultrapassou o limite. Reduza a quantidade.' };
  return { items, pending };
}

async function advanceOrder(phone, store, c, items, nextState) {
  if (nextState === 'order_addon' && productsByCategory(c, 'addon').length) {
    await store.setSession(phone, 'order_addon', { items });
    return addonCatalog(c);
  }
  if (nextState === 'order_addon') nextState = 'order_drink';
  if (nextState === 'order_drink' && productsByCategory(c, 'drink').length) {
    await store.setSession(phone, 'order_drink', { items });
    return drinkCatalog(c);
  }
  await store.setSession(phone, 'order_items', { items });
  return cartReply(items);
}

const packageReview = item => `✅ Pacote selecionado\n${item.name}\n\n📋 O que vem no pedido:\n${item.details}\n\nValor estimado: ${money(item.priceCents * item.quantity)}${item.customization ? `\n\n✏️ Alterações solicitadas:\n${item.customization}` : ''}\n\n1 — ACEITAR PACOTE\n2 — EDITAR OU TROCAR ITENS\n\nAlterações podem mudar o valor e serão confirmadas pela equipe.`;

function updatePackageComponents(item, components) {
  const normalized = components.map((component, index) => ({ ...component, index: index + 1 }));
  return {
    ...item,
    components: normalized,
    priceCents: normalized.reduce((sum, component) => sum + component.priceCents, 0),
    details: normalized.length ? `• ${normalized.map(component => `${component.amountLabel} de ${component.name} — ${money(component.priceCents)}`).join('\n• ')}` : 'Nenhum item do pacote.'
  };
}

function packageEditor(item, c, items) {
  const current = (item.components || []).map((component, index) => `${index + 1} — ${component.amountLabel} de ${component.name} — ${money(component.priceCents)}`).join('\n') || 'Nenhum item no pacote.';
  const addons = productLines(productsByCategory(c, 'addon'));
  return `✏️ Editar pacote\n\nITENS ATUAIS\n${current}\n\nOPÇÕES PARA ADICIONAR OU TROCAR\n${addons}\n\nComandos:\nREMOVER 3\nADICIONAR 22\nADICIONAR 22 25 22 26\nADICIONAR 2x22\nTROCAR 3 POR 22\nCONCLUIR EDIÇÃO\n\nCódigos repetidos aumentam a quantidade. Os itens adicionados entram nesta lista e o total é recalculado automaticamente.`;
}

const comparableName = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

function addAddonToPackage(packageItem, product, quantity) {
  const addonName = product.name.replace(/^Cento de\s+/i, '');
  const addedUnits = quantity * 100;
  const components = (packageItem.components || []).map(component => ({ ...component }));
  const existingIndex = components.findIndex(component => comparableName(component.name) === comparableName(addonName) && component.unit === 'unidades');
  if (existingIndex >= 0) {
    const current = components[existingIndex];
    const currentUnits = Number.isFinite(current.quantity) ? current.quantity : Number(String(current.amountLabel).replace(/\D/g, '')) || 0;
    components[existingIndex] = {
      ...current,
      quantity: currentUnits + addedUnits,
      amountLabel: `${(currentUnits + addedUnits).toLocaleString('pt-BR')} unidades`,
      priceCents: current.priceCents + product.priceCents * quantity
    };
  } else {
    components.push({ name: addonName, quantity: addedUnits, unit: 'unidades', amountLabel: `${addedUnits.toLocaleString('pt-BR')} unidades`, priceCents: product.priceCents * quantity });
  }
  return updatePackageComponents(packageItem, components);
}

async function continueAfterReview(phone, store, c, data) {
  const items = (data.items || []).map(item => ({ ...item }));
  const pending = [...(data.pending || [])];
  if (pending.length) {
    await store.setSession(phone, 'order_option', { items, pending, nextState: data.nextState });
    const nextProduct = c.products.find(item => item.id === pending[0].id);
    return optionQuestion(nextProduct, pending[0].quantity);
  }
  return advanceOrder(phone, store, c, items, data.nextState || 'order_items');
}

export async function handleOrder({ phone, input, session, store, c }) {
  const n = input.toLowerCase();
  const active = session.state.startsWith('order_');
  const data = session.data || {};
  if (['menu', 'section_order', 'section_tracking'].includes(session.state) && (n === '5' || /^(acompanhar(?: pedido)?|meus pedidos|status(?: pedido)?)$/.test(n))) {
    const orders = await store.listOrders(phone);
    await store.setSession(phone, 'section_tracking');
    return orders.length ? orders.map(o => `Pedido #${o.id}: ${orderStatus(o.status)} — ${money(Math.round(o.total * 100))}`).join('\n') : 'Você ainda não tem pedidos registrados.';
  }
  if (n === 'cancelar pedido' && active) {
    await store.setSession(phone, 'section_order');
    return 'Carrinho cancelado. Digite 0 ou VOLTAR para retornar ao menu.';
  }
  if ((active || session.state === 'section_order') && (n === 'carrinho' || n === 'continuar')) {
    if (!data.items?.length) return 'Seu carrinho está vazio. Envie PEDIDOS para começar.';
    return cartReply(data.items);
  }
  if (session.state === 'order_confirm' && n === 'editar') {
    await store.setSession(phone, 'order_items', { items: data.items || [] });
    return cartReply(data.items || []);
  }
  if (session.state === 'section_catalog') {
    if (['4', 'pedido', 'pedidos', 'fazer pedido', 'novo pedido'].includes(n)) {
      await store.setSession(phone, 'order_food', { items: [] });
      return foodCatalog(c);
    }
    if (validSelection(n)) {
      const orderSession = { state: 'order_food', data: { items: [] } };
      await store.setSession(phone, orderSession.state, orderSession.data);
      return handleOrder({ phone, input, session: orderSession, store, c });
    }
  }
  if (session.state === 'menu' && (['4', 'pedido', 'pedidos', 'fazer pedido', 'novo pedido'].includes(n))) {
    if (!c.products?.length) return 'O cardápio de pedidos ainda não foi configurado. Digite 9 para falar com a equipe.';
    await store.setSession(phone, 'order_food', { items: [] });
    return foodCatalog(c);
  }
  if (!active) return null;
  if (n === 'pedidos') return session.state === 'order_addon' ? addonCatalog(c) : session.state === 'order_drink' ? drinkCatalog(c) : foodCatalog(c);
  if (session.state === 'order_package_review') {
    const packageItem = (data.items || []).find(item => item.id === data.packageItemId);
    if (!packageItem) return continueAfterReview(phone, store, c, data);
    if (['1', 'aceitar', 'aceitar pacote', 'confirmar pacote', 'continuar'].includes(n)) return continueAfterReview(phone, store, c, data);
    if (['2', 'editar', 'editar pacote', 'trocar', 'trocar itens'].includes(n)) {
      await store.setSession(phone, 'order_package_changes', data);
      return packageEditor(packageItem, c, data.items || []);
    }
    return `${packageReview(packageItem)}\n\nResponda 1 para aceitar ou 2 para editar.`;
  }
  if (session.state === 'order_package_changes') {
    let items = (data.items || []).map(item => ({ ...item, ...(item.components ? { components: item.components.map(component => ({ ...component })) } : {}) }));
    let packageItem = items.find(item => item.id === data.packageItemId);
    if (!packageItem) return continueAfterReview(phone, store, c, data);
    if (['concluir', 'concluir edição', 'concluir edicao', 'pronto'].includes(n)) {
      await store.setSession(phone, 'order_package_review', { ...data, items });
      return packageReview(packageItem);
    }
    const removeMatch = n.match(/^remover\s+(\d+)$/);
    const addCommand = n.match(/^adicionar\s+(.+)$/);
    const swapMatch = n.match(/^trocar\s+(\d+)\s+por\s+(\d+)$/);
    const additions = [];
    if (addCommand) {
      for (const part of selectionParts(addCommand[1])) {
        const match = part.trim().match(/^(?:(\d+)x)?(\d+)$/);
        if (!match) return `Use os códigos separados por espaço. Exemplo: ADICIONAR 22 25 22 ou ADICIONAR 2x22.\n\n${packageEditor(packageItem, c, items)}`;
        const quantity = Number(match[1] || 1);
        const product = c.products.find(item => item.id === Number(match[2]) && item.category === 'addon');
        if (!product || quantity < 1 || quantity > 99) return `O número ${match[2]} não existe nas opções para adicionar.\n\n${packageEditor(packageItem, c, items)}`;
        additions.push({ product, quantity });
      }
    }
    if (removeMatch || swapMatch) {
      const componentIndex = Number((removeMatch || swapMatch)[1]) - 1;
      if (!packageItem.components?.[componentIndex]) return `O item ${componentIndex + 1} não existe no pacote.\n\n${packageEditor(packageItem, c, items)}`;
      const components = packageItem.components.filter((_, index) => index !== componentIndex);
      packageItem = updatePackageComponents(packageItem, components);
      items = items.map(item => item.id === data.packageItemId ? packageItem : item);
    }
    if (swapMatch) {
      const productId = Number(swapMatch[2]);
      const quantity = 1;
      const product = c.products.find(item => item.id === productId && item.category === 'addon');
      if (!product || quantity < 1 || quantity > 99) return `Use um código da lista de adicionais.\n\n${packageEditor(packageItem, c, items)}`;
      packageItem = addAddonToPackage(packageItem, product, quantity);
      items = items.map(item => item.id === data.packageItemId ? packageItem : item);
    }
    for (const addition of additions) packageItem = addAddonToPackage(packageItem, addition.product, addition.quantity);
    if (additions.length) items = items.map(item => item.id === data.packageItemId ? packageItem : item);
    if (!removeMatch && !addCommand && !swapMatch) return `Comando não reconhecido. Use REMOVER, ADICIONAR, TROCAR ou CONCLUIR EDIÇÃO.\n\n${packageEditor(packageItem, c, items)}`;
    await store.setSession(phone, 'order_package_changes', { ...data, items });
    packageItem = items.find(item => item.id === data.packageItemId);
    return `Alteração aplicada. Novo total do pacote: ${money(packageItem.priceCents)}.\n\n${packageEditor(packageItem, c, items)}`;
  }
  if (session.state === 'order_option') {
    const items = (data.items || []).map(item => ({ ...item }));
    const pending = [...(data.pending || [])];
    const current = pending[0];
    const product = c.products.find(item => item.id === current?.id);
    if (!product?.options?.length) {
      await store.setSession(phone, data.nextState || 'order_items', { items });
      return 'Essa opção não está mais disponível. Revise o carrinho e escolha novamente.';
    }
    const optionNumber = Number(n);
    const option = Number.isInteger(optionNumber) && optionNumber >= 1 && optionNumber <= product.options.length
      ? product.options[optionNumber - 1]
      : product.options.find(item => optionText(item).toLowerCase() === n);
    if (!option) return `${/^\d+$/.test(n) ? `O número ${n} não existe nesta etapa.` : 'Essa opção não existe nesta etapa.'}\nVeja abaixo as opções disponíveis.\n\n${optionQuestion(product, current.quantity)}`;
    if (option && typeof option === 'object' && option.customGuestCount) {
      await store.setSession(phone, 'order_custom_guests', { items, pending, nextState: data.nextState, productId: product.id, quantity: current.quantity });
      return 'Informe a quantidade exata de convidados usando apenas um número inteiro. Exemplo: 73.';
    }
    const error = addProduct(items, product, current.quantity, option);
    if (error) return error;
    pending.shift();
    if (product.package && !product.customOrder) {
      const packageItem = items.find(item => item.id === product.id);
      await store.setSession(phone, 'order_package_review', { items, pending, nextState: data.nextState, packageItemId: product.id });
      return packageReview(packageItem);
    }
    if (pending.length) {
      await store.setSession(phone, 'order_option', { items, pending, nextState: data.nextState });
      const nextProduct = c.products.find(item => item.id === pending[0].id);
      return optionQuestion(nextProduct, pending[0].quantity);
    }
    return advanceOrder(phone, store, c, items, data.nextState || 'order_items');
  }
  if (session.state === 'order_custom_guests') {
    const guestCount = Number(input);
    if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 5000) return 'Informe uma quantidade inteira entre 1 e 5.000 convidados. Exemplo: 73.';
    const items = (data.items || []).map(item => ({ ...item }));
    const pending = [...(data.pending || [])];
    const product = c.products.find(item => item.id === data.productId);
    if (!product) return 'Esse buffet não está mais disponível. Digite 0 para voltar ao menu.';
    const error = addProduct(items, product, data.quantity || 1, customPackageOption(product, guestCount));
    if (error) return error;
    pending.shift();
    if (product.package && !product.customOrder) {
      const packageItem = items.find(item => item.id === product.id);
      await store.setSession(phone, 'order_package_review', { items, pending, nextState: data.nextState, packageItemId: product.id });
      return packageReview(packageItem);
    }
    if (pending.length) {
      await store.setSession(phone, 'order_option', { items, pending, nextState: data.nextState });
      const nextProduct = c.products.find(item => item.id === pending[0].id);
      return optionQuestion(nextProduct, pending[0].quantity);
    }
    return advanceOrder(phone, store, c, items, data.nextState || 'order_items');
  }
  if (session.state === 'order_food') {
    const items = (data.items || []).map(item => ({ ...item }));
    const directProduct = /^\d+$/.test(n) ? c.products.find(item => item.id === Number(n)) : null;
    if (directProduct?.customOrder) {
      await store.setSession(phone, 'order_custom_guests', { items, pending: [{ id: directProduct.id, quantity: 1 }], nextState: 'order_addon', productId: directProduct.id, quantity: 1 });
      return 'Quantos convidados participarão? Envie qualquer número inteiro entre 1 e 5.000. Exemplo: 73.';
    }
    const result = collectSelections(n, items, c, 'food');
    if (result.error) return `${result.error}\n\n${foodCatalog(c)}`;
    if (result.pending.length) {
      await store.setSession(phone, 'order_option', { items, pending: result.pending, nextState: 'order_addon' });
      const product = c.products.find(item => item.id === result.pending[0].id);
      return optionQuestion(product, result.pending[0].quantity);
    }
    return advanceOrder(phone, store, c, items, 'order_addon');
  }
  if (session.state === 'order_addon') {
    const items = (data.items || []).map(item => ({ ...item }));
    if (['sem adicionais', 'sem adicional', 'não', 'nao', 'pular'].includes(n)) return advanceOrder(phone, store, c, items, 'order_drink');
    const result = collectSelections(n, items, c, 'addon');
    if (result.error) return `${result.error}\n\n${addonCatalog(c)}`;
    if (result.pending.length) {
      await store.setSession(phone, 'order_option', { items, pending: result.pending, nextState: 'order_drink' });
      const product = c.products.find(item => item.id === result.pending[0].id);
      return optionQuestion(product, result.pending[0].quantity);
    }
    return advanceOrder(phone, store, c, items, 'order_drink');
  }
  if (session.state === 'order_drink') {
    const items = (data.items || []).map(item => ({ ...item }));
    if (['sem bebida', 'não', 'nao', 'pular'].includes(n)) return advanceOrder(phone, store, c, items, 'order_items');
    const result = collectSelections(n, items, c, 'drink');
    if (result.error) return `${result.error}\n\n${drinkCatalog(c)}`;
    if (result.pending.length) {
      await store.setSession(phone, 'order_option', { items, pending: result.pending, nextState: 'order_items' });
      const product = c.products.find(item => item.id === result.pending[0].id);
      return optionQuestion(product, result.pending[0].quantity);
    }
    return advanceOrder(phone, store, c, items, 'order_items');
  }
  if (session.state === 'order_items') {
    const items = (data.items || []).map(p => ({ ...p }));
    if (n === 'finalizar') {
      if (!items.some(item => item.priceCents > 0)) return 'Adicione pelo menos um salgado ou uma bebida antes de finalizar.';
      await store.setSession(phone, 'order_payment', { items });
      return paymentQuestion();
    }
    if (/^remover\s+\d+$/.test(n)) {
      const id = Number(n.split(/\s+/)[1]);
      if (!items.some(p => p.id === id)) return 'Esse item não está no carrinho.';
      const removedPackage = items.some(p => p.id === id && p.package);
      const remaining = items.filter(p => p.id !== id && !(removedPackage && p.perGuest));
      await store.setSession(phone, 'order_items', { items: remaining });
      return remaining.length ? `${summary(remaining)}\nSubtotal: ${money(total(remaining))}\nAdicione itens, envie FINALIZAR ou CANCELAR PEDIDO.` : 'Carrinho vazio. Adicione itens pelo número do cardápio ou envie CANCELAR PEDIDO.';
    }
    const result = collectSelections(n, items, c);
    if (result.error) return `${result.error} Para concluir, envie FINALIZAR.`;
    if (result.pending.length) {
      await store.setSession(phone, 'order_option', { items, pending: result.pending, nextState: 'order_items' });
      const product = c.products.find(item => item.id === result.pending[0].id);
      return optionQuestion(product, result.pending[0].quantity);
    }
    await store.setSession(phone, 'order_items', { items });
    return cartReply(items);
  }
  if (session.state === 'order_payment') {
    const payment = ['1', 'dinheiro'].includes(n) ? 'cash'
      : ['2', 'pix'].includes(n) ? 'pix_pending'
      : ['3', 'cartão de crédito', 'cartao de credito', 'crédito', 'credito'].includes(n) ? 'credit_card'
      : ['4', 'cartão de débito', 'cartao de debito', 'débito', 'debito'].includes(n) ? 'debit_card'
      : '';
    if (!payment) return `Essa forma de pagamento não existe.\n\n${paymentQuestion()}`;
    if (payment === 'pix_pending' && !c.pixKey) return `O PIX está temporariamente indisponível. Escolha outra forma de pagamento.\n\n${paymentQuestion()}`;
    await store.setSession(phone, 'order_fulfillment', { ...data, payment });
    return `Pagamento escolhido: ${paymentLabel(payment)}.\n\nComo você quer receber?\n\n1 — RETIRAR NO LOCAL\n2 — ENTREGA\n\nResponda 1, 2, RETIRADA ou ENTREGA.`;
  }
  if (session.state === 'order_fulfillment') {
    if (['1', 'retirada', 'retirar', 'retirar no local'].includes(n)) {
      const next = { ...data, address: 'RETIRADA', feeCents: 0 };
      await store.setSession(phone, 'order_confirm', next);
      return `${summary(data.items)}\nRetirada no restaurante\nTaxa: ${money(0)}\nTotal: ${money(total(data.items))}\nPagamento: ${paymentLabel(data.payment)}\nEnvie CONFIRMAR, EDITAR ou CANCELAR PEDIDO.`;
    }
    if (['2', 'entrega', 'entregar'].includes(n)) {
      await store.setSession(phone, 'order_delivery_address', data);
      return 'Informe o endereço completo para entrega, com rua, número, bairro e cidade.';
    }
    return 'Escolha 1 para RETIRAR NO LOCAL ou 2 para ENTREGA.';
  }
  if (session.state === 'order_delivery_address') {
    if (input.length < 8) return 'Informe o endereço completo, com rua, número, bairro e cidade.';
    const feeCents = Math.round(c.deliveryFee * 100);
    if (!Number.isSafeInteger(feeCents) || feeCents < 0) return 'A taxa de entrega precisa ser corrigida pela equipe.';
    const next = { ...data, address: input, feeCents };
    await store.setSession(phone, 'order_confirm', next);
    return `${summary(data.items)}\nEntrega: ${input}\nTaxa: ${money(feeCents)}\nTotal: ${money(total(data.items) + feeCents)}\nPagamento: ${paymentLabel(data.payment)}\nEnvie CONFIRMAR, EDITAR ou CANCELAR PEDIDO.`;
  }
  if (session.state === 'order_confirm') {
    if (n !== 'confirmar') return 'Envie CONFIRMAR para registrar, EDITAR para alterar ou CANCELAR PEDIDO.';
    if (data.payment === 'pix_pending' && !c.pixKey) return 'O PIX está indisponível. Envie EDITAR e escolha outra forma de pagamento.';
    const cents = total(data.items) + data.feeCents;
    const id = await store.createOrder({ phone, items: data.items, total: cents / 100, address: data.address, payment: data.payment, eta: c.deliveryMinutes });
    await store.setSession(phone, 'section_order');
    const paymentInstructions = data.payment === 'pix_pending'
      ? `Chave PIX: ${c.pixKey}${c.pixRecipient ? `\nFavorecido: ${c.pixRecipient}` : ''}\nPagamento aguardando conferência.`
      : `Forma de pagamento: ${paymentLabel(data.payment)}.`;
    return `Pedido #${id} registrado!\n${summary(data.items)}\nTaxa: ${money(data.feeCents)}\nTotal: ${money(cents)}\n\n${paymentInstructions}\nEnvie 5 para consultar o pedido. Avisaremos quando o status for atualizado.`;
  }
  await store.setSession(phone, 'menu');
  return 'Envie PEDIDOS para iniciar um carrinho.';
}

export async function updateOrder({ command, rest, store, env }) {
  if (rest.length !== 1 || !/^[1-9]\d*$/.test(rest[0]) || !Number.isSafeInteger(Number(rest[0]))) return `Use: ${command} 123`;
  const order = await store.getOrder(Number(rest[0]));
  if (!order) return 'Pedido não encontrado.';
  const status = { preparando: 'preparing', pronto: 'ready', saiu: 'out_for_delivery', entregue: 'delivered' }[command];
  if (order.status === status) return `Pedido #${order.id} já está nesse status.`;
  const pickup = order.address === 'RETIRADA';
  const next = { received: 'preparing', preparing: pickup ? 'ready' : 'out_for_delivery', ready: 'delivered', out_for_delivery: 'delivered' };
  if (next[order.status] !== status) return `Mudança inválida. Status atual: ${orderStatus(order.status)}. Próximo: ${orderStatus(next[order.status] || 'nenhum')}.`;
  if (!env?.WHATSAPP_TOKEN || !env?.WHATSAPP_PHONE_NUMBER_ID) return 'Configure o WhatsApp antes de atualizar e avisar o cliente.';
  if (!await store.setOrderStatus(order.id, order.status, status)) return 'O pedido mudou durante a operação. Consulte o status e tente novamente.';
  try {
    await sendText(env, order.phone, `Pedido #${order.id}: ${orderStatus(status)}.`);
    return `Pedido #${order.id}: ${orderStatus(status)}. Cliente avisado.`;
  } catch (error) {
    console.error('Falha no aviso do pedido', order.id, error);
    return `Pedido #${order.id} atualizado, mas o aviso falhou. Avise o cliente manualmente.`;
  }
}
