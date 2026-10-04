export function config(env) {
  const configuredProducts = parseProducts(env.PRODUCTS_JSON);
  new Intl.DateTimeFormat('pt-BR', { timeZone: env.TIMEZONE || 'America/Sao_Paulo' }).format();
  return {
    products: configuredProducts.length ? configuredProducts : env.ALLOW_DEMO_CATALOG === 'true' ? defaultProducts() : [],
    pixKey: env.PIX_KEY || '',
    pixRecipient: env.PIX_RECIPIENT || '',
    name: env.BUSINESS_NAME || 'Restaurante',
    timezone: env.TIMEZONE || 'America/Sao_Paulo',
    token: env.WHATSAPP_TOKEN,
    phoneId: env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    adminToken: env.ADMIN_TOKEN,
    internalNumbers: (env.INTERNAL_NUMBERS || '')
      .split(',')
      .map(normalizePhone)
      .filter(Boolean),
    hours: env.OPENING_HOURS || 'Horário não configurado.',
    address: env.ADDRESS || 'Endereço não configurado.',
    menuUrl: env.MENU_URL || '',
    deliveryFee: numberSetting(env.DELIVERY_BASE_FEE ?? '6', 'DELIVERY_BASE_FEE', 0, 10000),
    deliveryMinutes: numberSetting(env.DELIVERY_MINUTES ?? '45', 'DELIVERY_MINUTES', 1, 1440, true),
    paymentPixLink: env.PAYMENT_PIX_LINK || ''
  };
}

function numberSetting(raw, name, min, max, integer = false) {
  const value = Number(raw);
  if (String(raw).trim() === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error(`Configuração inválida: ${name}.`);
  return value;
}

export function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

export function nowIso() {
  return new Date().toISOString();
}
function parseProducts(raw) {
  if (!raw) return [];
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error('O catálogo deve ser uma lista.');
    const ids = new Set();
    return items.map(p => {
      if (!p || !Number.isSafeInteger(p.id) || p.id < 1 || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || !Number.isSafeInteger(p.priceCents) || p.priceCents < (p.customOrder ? 0 : 1)) throw new Error('Produto inválido ou código repetido.');
      ids.add(p.id);
      const options = (p.options || []).map(normalizeOption);
      if (!Array.isArray(p.options || []) || options.some(option => !option) || options.length > 20) throw new Error('Opções inválidas.');
      const composition = (p.composition || []).map(item => {
        if (!item || typeof item.name !== 'string' || !item.name.trim() || !Number.isFinite(item.perGuest) || item.perGuest <= 0 || !['gramas', 'unidades'].includes(item.unit)) throw new Error('Composição inválida.');
        const priceKey = item.unit === 'gramas' ? 'pricePerKgCents' : 'pricePerHundredCents';
        if (!Number.isSafeInteger(item[priceKey]) || item[priceKey] < 1) throw new Error('Preço da composição inválido.');
        return { name: item.name.trim(), perGuest: item.perGuest, unit: item.unit, [priceKey]: item[priceKey] };
      });
      return {
      id: p.id,
      name: p.name.trim(),
      priceCents: p.priceCents,
      category: ['food', 'addon', 'drink', 'dessert'].includes(p.category) ? p.category : 'food',
      package: Boolean(p.package),
      customOrder: Boolean(p.customOrder),
      description: typeof p.description === 'string' ? p.description.trim() : '',
      composition,
      optionLabel: typeof p.optionLabel === 'string' ? p.optionLabel.trim() : '',
      options
      };
    });
  } catch { throw new Error('PRODUCTS_JSON inválido. Corrija o catálogo antes de aceitar pedidos.'); }
}

function normalizeOption(option) {
  if (typeof option === 'string' && option.trim()) return option.trim();
  if (!option || typeof option !== 'object' || typeof option.label !== 'string' || !option.label.trim()) return null;
  const normalized = { label: option.label.trim() };
  for (const key of ['priceCents', 'pricePerGuestCents', 'guestCount']) {
    if (option[key] !== undefined) {
      if (!Number.isSafeInteger(option[key]) || option[key] < 1) return null;
      normalized[key] = option[key];
    }
  }
  if (option.customGuestCount === true) normalized.customGuestCount = true;
  return normalized;
}

function compositionTotalCents(composition, guestCount) {
  return composition.reduce((sum, item) => {
    const amount = item.perGuest * guestCount;
    const cost = item.unit === 'gramas'
      ? Math.round((amount / 1000) * item.pricePerKgCents)
      : Math.round((Math.ceil(amount) / 100) * item.pricePerHundredCents);
    return sum + cost;
  }, 0);
}

function buffetPackage(id, name, _pricePerPerson, composition) {
  const factors = [[50, 1], [100, 0.95], [200, 0.90], [500, 0.82], [1000, 0.75]];
  const options = factors.map(([guestCount]) => {
    const priceCents = compositionTotalCents(composition, guestCount);
    const totalReais = priceCents / 100;
    return { label: `Pacote para ${guestCount} convidados — total dos itens: R$ ${totalReais.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`, guestCount, priceCents };
  });
  options.push({ label: 'Outra quantidade de convidados', customGuestCount: true });
  return { id, name, priceCents: options[0].priceCents, category: 'food', package: true, composition, optionLabel: 'Para quantas pessoas?', options };
}

function defaultProducts() {
  const customOrder = {
    id: 1,
    name: 'Monte seu próprio pedido',
    priceCents: 0,
    category: 'food',
    package: true,
    customOrder: true,
    description: 'Você escolhe separadamente os centos de salgados e as bebidas. Não existe valor mínimo automático de buffet.',
    optionLabel: 'Para quantos convidados você quer montar o pedido?',
    options: []
  };
  const u = (name, perGuest, pricePerHundredCents = 11000) => ({ name, perGuest, unit: 'unidades', pricePerHundredCents });
  const g = (name, perGuest, pricePerKgCents = 3000) => ({ name, perGuest, unit: 'gramas', pricePerKgCents });
  const buffets = [
    [2, 'Buffet Festa Clássica', 112, [u('Coxinhas', 2), u('Quibes', 2), u('Bolinhas de queijo', 2), u('Risoles', 2), u('Mini-hambúrgueres', 1, 35000), u('Mini hot dogs', 1, 28000)]],
    [3, 'Buffet de Salgados Tradicionais', 110, [u('Coxinhas', 2), u('Quibes', 2), u('Bolinhas de queijo', 2), u('Risoles', 2), u('Croquetes', 2), u('Enroladinhos', 2)]],
    [4, 'Churrasco Prata', 165, [g('Contra-filé', 180), g('Frango', 120), g('Linguiça', 100), g('Arroz', 150), g('Farofa', 60), g('Vinagrete', 80), g('Maionese', 100), g('Salada', 80), u('Pães de alho', 1)]],
    [5, 'Churrasco Ouro', 190, [g('Contra-filé', 150), g('Maminha', 120), g('Frango', 100), g('Linguiça', 80), g('Queijo coalho', 50), g('Arroz', 150), g('Farofa', 60), g('Vinagrete', 80), g('Maionese', 100), g('Salada', 80), u('Pães de alho', 1)]],
    [6, 'Hambúrguer Artesanal', 159, [u('Hambúrgueres bovinos', 1), u('Pães brioche', 1), u('Fatias de queijo', 2), u('Porções de bacon', 1), g('Alface e tomate', 60), g('Batata frita', 150), g('Molhos variados', 50)]],
    [7, 'Crepe Francês', 289, [u('Crepes de carne', 1), u('Crepes de frango', 1), u('Crepes de quatro queijos ou vegetarianos', 1), g('Saladas', 100), g('Molho ao sugo', 60), g('Molho branco', 60)]],
    [8, 'Massas Italianas', 269, [g('Penne', 100), g('Espaguete', 100), g('Nhoque', 100), g('Molho ao sugo', 80), g('Molho branco', 80), g('Molho bolonhesa', 80), g('Salada', 100), u('Pães italianos', 1), g('Queijo ralado', 20)]],
    [9, 'Festival de Pizza', 140, [u('Fatias de pizza de muçarela', 2), u('Fatias de pizza de calabresa', 1), u('Fatias de frango com catupiry', 1), u('Fatias de marguerita', 1), u('Fatias vegetarianas', 1)]],
    [10, 'Comida de Boteco', 149, [u('Pastéis', 2), g('Mandioca frita', 120), g('Calabresa acebolada', 100), u('Bolinhos de carne', 2), g('Frango a passarinho', 150), g('Polenta frita', 100), g('Molhos', 40)]],
    [11, 'Feijoada Completa', 168, [g('Feijoada', 400), g('Arroz branco', 150), g('Couve', 60), g('Farofa', 60), g('Vinagrete', 60), g('Torresmo', 60), u('Laranjas', 0.5), g('Molho de pimenta', 20)]],
    [12, 'Café da Manhã', 100, [u('Pães franceses', 2), u('Pães de queijo', 3), g('Frios', 100), g('Frutas', 200), u('Fatias de bolo simples', 1), g('Manteiga, geleia e requeijão', 50)]],
    [13, 'Brunch Especial', 130, [u('Pães variados', 2), g('Frios', 100), u('Mini quiches', 1), u('Fatias de torta salgada', 1), u('Ovos', 2), g('Frutas', 150), g('Salada', 100)]],
    [14, 'Finger Food', 149, [u('Canapés', 3), u('Mini quiches', 2), u('Bruschettas', 2), u('Mini sanduíches', 2), u('Escondidinhos individuais', 1), u('Salgados finos', 3)]],
    [15, 'Coquetel Volante', 149, [u('Canapés frios', 3), u('Canapés quentes', 3), u('Mini quiches', 2), u('Folhados', 2), u('Salgados finos', 3), u('Porções quentes individuais', 1)]],
    [16, 'Jantar Tradicional', 149, [g('Carne bovina', 180), g('Frango', 150), g('Arroz', 150), g('Massa', 180), g('Batatas', 120), g('Legumes', 100), g('Salada verde', 80), g('Salada de maionese', 100)]],
    [17, 'Jantar Premium', 190, [g('Filé-mignon', 180), g('Salmão ou frango', 160), g('Risoto', 180), g('Massa especial', 150), g('Legumes', 100), g('Salada elaborada', 100), u('Entradas individuais', 3)]],
    [18, 'Casamento Esmeralda', 150, [u('Canapés frios', 3), u('Canapés quentes', 2), g('Carne branca', 150), g('Carne vermelha', 150), g('Massa ou risoto', 200), g('Saladas', 120)]],
    [19, 'Casamento Rubi', 188, [u('Canapés', 6), g('Antepastos', 120), g('Carne branca', 160), g('Carne vermelha', 180), g('Massa ou risoto', 200), g('Acompanhamentos', 150), g('Saladas', 120)]],
    [20, 'Casamento Diamante', 228, [u('Canapés', 8), g('Antepastos', 150), g('Filé-mignon', 180), g('Peixe', 160), g('Massa', 150), g('Risoto', 150), g('Acompanhamentos', 150), g('Saladas', 120)]],
    [21, 'Buffet Vegetariano e Vegano', 150, [g('Antepastos', 120), g('Saladas', 150), g('Legumes assados', 180), g('Risoto vegano', 180), g('Massa sem ingredientes animais', 180), g('Proteína vegetal', 150), u('Salgados veganos', 4)]]
  ].map(args => buffetPackage(...args));

  const addons = [
    [22, 'Cento de coxinhas', 11000],
    [23, 'Cento de quibes', 11000],
    [24, 'Cento de bolinhas de queijo', 11000],
    [25, 'Cento de risoles', 11000],
    [26, 'Cento de empadinhas', 13000],
    [27, 'Cento de mini esfihas', 13000],
    [28, 'Cento de mini pizzas', 13000],
    [29, 'Cento de enroladinhos de salsicha', 11000],
    [30, 'Cento de croquetes de carne', 11000],
    [31, 'Cento de churros', 12000]
  ].map(([id, name, priceCents]) => ({ id, name, priceCents, category: 'addon', options: [] }));

  const guestOptions = (labels, pricePerGuestCents) => labels.map(label => ({ label, pricePerGuestCents }));
  return [customOrder, ...buffets, ...addons,
    { id: 32, name: 'Água', priceCents: 600, category: 'drink', optionLabel: 'Escolha a água', options: guestOptions(['Sem gás — R$ 6 por pessoa', 'Com gás — R$ 7 por pessoa'], 600).map((o, i) => ({ ...o, pricePerGuestCents: i ? 700 : 600 })) },
    { id: 33, name: 'Refrigerantes', priceCents: 1200, category: 'drink', optionLabel: 'Escolha o refrigerante', options: guestOptions(['Coca-Cola', 'Coca-Cola Zero', 'Guaraná', 'Guaraná Zero', 'Fanta Laranja', 'Sprite'], 1200) },
    { id: 34, name: 'Sucos naturais', priceCents: 1500, category: 'drink', optionLabel: 'Escolha o sabor do suco', options: guestOptions(['Laranja', 'Limão', 'Maracujá', 'Abacaxi com hortelã', 'Morango'], 1500) },
    { id: 35, name: 'Chá gelado', priceCents: 1000, category: 'drink', optionLabel: 'Escolha o sabor', options: guestOptions(['Limão', 'Pêssego'], 1000) }
  ];
}
