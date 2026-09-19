import { handleOrder, updateOrder } from './orders.js';
import { sendText, sendDocument } from './whatsapp.js';

export const menu = (c) => `Olá! 👋 Sou o assistente do ${c.name}.

Digite uma opção:
1 - Cardápio e disponibilidade
2 - Horários, endereço e unidades
3 - Fazer ou alterar reserva
4 - Fazer pedido online
5 - Acompanhar pedido
6 - Consultar lista de espera
7 - Avaliar atendimento
8 - Falar com atendente
9 - Fidelidade, cupons e aniversário
10 - Alergias e restrições alimentares
0 - Voltar ao menu`;

function parseDateTime(text) {
  const match = text.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})\s+([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) return null;
  const [, dayText, monthText, yearText, hour, minute] = match;
  const day = Number(dayText), month = Number(monthText), year = Number(yearText);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day) return null;
  return { date: `${dayText}/${monthText}/${yearText}`, time: `${hour}:${minute}` };
}

function parseBirthDate(text) {
  const match = text.trim().match(/^(\d{2})[/.](\d{2})[/.](\d{4})$/);
  if (!match) return null;
  const [, dayText, monthText, yearText] = match;
  const day = Number(dayText), month = Number(monthText), year = Number(yearText);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCFullYear() !== year || value.getUTCMonth() !== month - 1 || value.getUTCDate() !== day || value > new Date()) return null;
  return `${dayText}/${monthText}/${yearText}`;
}

export async function handleClient({ phone, text, name, store, env, c }) {
  const input = String(text || '').trim();
  const n = input.toLowerCase();
  const session = await store.getSession(phone);
  await store.saveContact(phone, name);

  if (n === '0' || n === 'voltar') {
    await store.setSession(phone, 'menu'); return menu(c);
  }
  if (session.state === 'menu' && ['oi','olá','ola','menu','início','inicio'].includes(n)) return menu(c);
  const orderReply = await handleOrder({ phone, input, session, store, c });
  if (orderReply !== null) return orderReply;
  if (session.state === 'reservation_date') {
    const parsed = parseDateTime(input);
    if (!parsed) return 'Informe uma data e um horário válidos no formato: DD/MM/AAAA HH:MM';
    const { date, time } = parsed;
    await store.setSession(phone, 'reservation_guests', { ...session.data, date, time });
    return 'Quantas pessoas? Responda apenas com o número.';
  }
  if (session.state === 'reservation_guests') {
    const guests = Number(input);
    if (!Number.isInteger(guests) || guests < 1) return 'Informe um número válido de pessoas.';
    await store.setSession(phone, 'reservation_name', { ...session.data, guests });
    return 'Qual nome devo colocar na reserva?';
  }
  if (session.state === 'reservation_name') {
    if (input.length < 2 || !/[A-Za-zÀ-ÿ]/.test(input)) return 'Informe um nome válido para a reserva.';
    const id = await store.createReservation({ phone, ...session.data, name: input });
    await store.setSession(phone, 'section_reservation');
    return `Reserva #${id} recebida para ${session.data.date} às ${session.data.time}, para ${session.data.guests} pessoas. Enviaremos a confirmação por aqui.\n\nDigite MINHAS RESERVAS para consultar ou 0 para voltar ao menu.`;
  }
  if (session.state === 'waitlist') {
    const guests = Number(input);
    if (!Number.isInteger(guests) || guests < 1) return 'Informe um número válido de pessoas.';
    await store.createWaitlist({ phone, name: name || 'Cliente', guests });
    const waiting = await store.waitlistStatus();
    await store.setSession(phone, 'section_waitlist');
    return `Você entrou na lista de espera. Agora há ${waiting.people_count} ${waiting.people_count === 1 ? 'pessoa' : 'pessoas'} em ${waiting.groups_count} ${waiting.groups_count === 1 ? 'grupo' : 'grupos'}. Avisaremos quando uma mesa estiver disponível.\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
  }
  if (session.state === 'event_datetime') {
    const parsed = parseDateTime(input);
    if (!parsed) return 'Informe uma data e um horário válidos no formato: DD/MM/AAAA HH:MM';
    await store.setSession(phone, 'event_guests', { ...session.data, ...parsed });
    return 'Quantas pessoas participarão do evento?';
  }
  if (session.state === 'event_guests') {
    const guests = Number(input);
    if (!Number.isInteger(guests) || guests < 1) return 'Informe um número válido de convidados.';
    await store.setSession(phone, 'event_details', { ...session.data, guests });
    return 'Descreva o tipo de evento ou alguma necessidade especial. Se não houver, envie SEM DETALHES.';
  }
  if (session.state === 'event_details') {
    const details = n === 'sem detalhes' ? '' : input;
    await store.createEvent({ phone, name: name || 'Cliente', date: `${session.data.date} ${session.data.time}`, guests: session.data.guests, details });
    await store.setSession(phone, 'section_event');
    return `Solicitação de evento registrada para ${session.data.date} às ${session.data.time}, com ${session.data.guests} pessoas. Nossa equipe retornará com as opções e valores.\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
  }
  if (session.state === 'feedback') {
    const rating = Number(input);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return 'Envie uma nota inteira de 1 a 5.';
    await store.log(phone, 'avaliacao_atendimento', String(rating));
    await store.setSession(phone, 'section_feedback');
    return `Obrigado! Sua avaliação ${rating}/5 foi registrada.\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
  }
  if (session.state === 'loyalty_name') {
    if (input.length < 2 || !/[A-Za-zÀ-ÿ]/.test(input)) return 'Informe seu nome completo. Para sair, digite 0 ou VOLTAR.';
    await store.setSession(phone, 'loyalty_birthdate', { name: input });
    return 'Informe sua data de nascimento no formato DD/MM/AAAA.';
  }
  if (session.state === 'loyalty_birthdate') {
    const birthdate = parseBirthDate(input);
    if (!birthdate) return 'Informe uma data de nascimento válida no formato DD/MM/AAAA. Para sair, digite 0 ou VOLTAR.';
    await store.log(phone, 'cadastro_fidelidade', JSON.stringify({ name: session.data.name, birthdate }));
    await store.setSession(phone, 'section_loyalty');
    return `Cadastro de fidelidade recebido para ${session.data.name}, aniversário em ${birthdate}.\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
  }
  if (session.state === 'allergy_details') {
    if (input.length < 2) return 'Descreva sua alergia ou restrição. Para sair, digite 0 ou VOLTAR.';
    await store.log(phone, 'alergia_restricao', input);
    await store.setSession(phone, 'section_allergies');
    return 'Informação registrada. A equipe deverá confirmar os ingredientes antes do preparo.\n\nDigite 0 ou VOLTAR para retornar ao menu.';
  }

  if ((session.state === 'menu' || session.state === 'section_reservation') && n.startsWith('cancelar reserva')) {
    const id = Number(input.match(/\d+/)?.[0]);
    if (!id) return 'Informe o número da reserva. Exemplo: CANCELAR RESERVA 123';
    await store.cancelReservation(phone, id); await store.setSession(phone, 'section_reservation');
    return `Solicitação de cancelamento da reserva #${id} registrada.`;
  }
  if ((session.state === 'menu' || session.state === 'section_reservation') && n.startsWith('alterar reserva')) {
    const id = Number(input.match(/\d+/)?.[0]);
    if (!id) return 'Informe o número da reserva. Exemplo: ALTERAR RESERVA 123';
    await store.setSession(phone, 'reservation_change', { id });
    return 'Agora informe a nova data e horário: DD/MM/AAAA HH:MM';
  }
  if ((session.state === 'menu' || session.state === 'section_reservation') && (n.includes('minhas reservas') || n.includes('ver reservas'))) {
    const reservations = await store.listReservations(phone); await store.setSession(phone, 'section_reservation');
    return reservations.length ? reservations.map(r => `Reserva #${r.id}: ${r.date} às ${r.time}, ${r.guests} pessoas (${r.status})`).join('\n') : 'Você não tem reservas ativas.';
  }
  if (session.state === 'reservation_change') {
    const parsed = parseDateTime(input);
    if (!parsed) return 'Informe uma data e um horário válidos no formato: DD/MM/AAAA HH:MM';
    const { date, time } = parsed;
    await store.setSession(phone, 'reservation_change_guests', { ...session.data, date, time });
    return 'Quantas pessoas serão?';
  }
  if (session.state === 'reservation_change_guests') {
    const guests = Number(input);
    if (!Number.isInteger(guests) || guests < 1) return 'Informe um número válido de pessoas.';
    await store.updateReservation(phone, session.data.id, session.data.date, session.data.time, guests);
    await store.setSession(phone, 'section_reservation'); return `Reserva #${session.data.id} atualizada para ${session.data.date} às ${session.data.time}, ${guests} pessoas. Digite 0 ou VOLTAR para retornar ao menu.`;
  }

  if (session.state === 'section_waitlist' && (n === 'entrar na lista' || n === 'entrar na lista de espera')) {
    await store.setSession(phone, 'waitlist');
    return 'Quantas pessoas fazem parte do seu grupo?';
  }
  if (session.state === 'section_reservation' && (n === 'nova reserva' || n === 'fazer reserva')) {
    await store.setSession(phone, 'reservation_date');
    return 'Informe a data e o horário no formato: DD/MM/AAAA HH:MM';
  }
  if (session.state.startsWith('section_')) {
    const sectionMessage = {
      section_catalog: 'Você está no cardápio.',
      section_hours: 'Você está em horários e endereço.',
      section_reservation: 'Você está em reservas. Envie NOVA RESERVA, MINHAS RESERVAS, ALTERAR RESERVA seguido do número ou CANCELAR RESERVA seguido do número.',
      section_order: 'Você está em pedidos.',
      section_tracking: 'Você está no acompanhamento de pedidos.',
      section_waitlist: 'Você está na lista de espera. Envie ENTRAR NA LISTA para participar.',
      section_event: 'Você está em eventos.',
      section_feedback: 'Você está na avaliação do atendimento.',
      section_human: 'Você está aguardando atendimento humano.',
      section_loyalty: 'Você está em fidelidade e aniversário.',
      section_allergies: 'Você está em alergias e restrições.'
    }[session.state] || 'Você está nesta opção.';
    return `${sectionMessage}\n\nPara acessar outra opção, digite 0 ou VOLTAR.`;
  }

  if (n === '1' || n.includes('cardápio') || n.includes('cardapio')) {
    await store.setSession(phone, 'section_catalog');
    if (c.products?.length) {
      const products = c.products.filter(product => (product.category || 'food') === 'food').map(product => `${product.id} — ${product.name}: ${product.package ? 'a partir de ' : ''}${(product.priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`).join('\n');
      const link = c.menuUrl && !c.menuUrl.includes('example.com') ? `\n\nCardápio completo: ${c.menuUrl}` : '';
      return `🎉 Buffets para festas\n\n${products}${link}\n\nEscolha 1 buffet. Depois você selecionará 50, 100, 200, 500 ou 1.000 convidados, adicionais por cento e bebidas. Valores estimados sujeitos à confirmação da equipe.`;
    }
    return c.menuUrl ? `Aqui está nosso cardápio: ${c.menuUrl}\n\nDigite 4 para fazer um pedido.` : 'O cardápio ainda não foi configurado. Digite 9 para falar com um atendente.';
  }
  if (n === '2' || n.includes('aberto') || n.includes('horário') || n.includes('endereço')) {
    await store.setSession(phone, 'section_hours'); return `${c.hours}\n\nEndereço: ${c.address}\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
  }
  if (n === '3') {
    await store.setSession(phone, 'section_reservation');
    return 'Reservas:\n\nEnvie NOVA RESERVA para reservar uma mesa, MINHAS RESERVAS para consultar, ALTERAR RESERVA seguido do número ou CANCELAR RESERVA seguido do número.\n\nDigite 0 ou VOLTAR para retornar ao menu.';
  }
  if (n === 'nova reserva' || n === 'fazer reserva') {
    await store.setSession(phone, 'reservation_date'); return 'Informe a data e o horário no formato: DD/MM/AAAA HH:MM';
  }
  if (n === '6' || n === 'lista de espera' || n === 'consultar lista de espera') {
    const waiting = await store.waitlistStatus();
    await store.setSession(phone, 'section_waitlist');
    if (!waiting.people_count) return 'A lista de espera está vazia no momento. Para entrar, envie ENTRAR NA LISTA.';
    return `No momento há ${waiting.people_count} ${waiting.people_count === 1 ? 'pessoa' : 'pessoas'} na lista de espera, em ${waiting.groups_count} ${waiting.groups_count === 1 ? 'grupo' : 'grupos'}. Para entrar, envie ENTRAR NA LISTA.`;
  }
  if (session.state === 'menu' && (n === 'entrar na lista' || n === 'entrar na lista de espera')) {
    await store.setSession(phone, 'waitlist');
    return 'Quantas pessoas fazem parte do seu grupo?';
  }
  if (n === '7' || n.includes('avali')) { await store.setSession(phone, 'feedback'); return 'De 1 a 5, como você avalia nosso atendimento? Para sair, digite 0 ou VOLTAR.'; }
  if (n === '8' || n.includes('atendente') || n.includes('humano')) { await store.setSession(phone, 'section_human'); return 'Certo. Um atendente humano assumirá a conversa em breve. Digite 0 ou VOLTAR para retornar ao menu.'; }
  if (n === '9' || n.includes('fidel') || n.includes('cupom') || n.includes('anivers')) { await store.setSession(phone, 'loyalty_name'); return 'Vamos fazer seu cadastro de fidelidade. Informe seu nome completo. Para sair, digite 0 ou VOLTAR.'; }
  if (n === '10' || n.includes('alerg') || n.includes('restri')) { await store.setSession(phone, 'allergy_details'); return 'Informe suas alergias ou restrições. A equipe confirmará os ingredientes antes do preparo. Para sair, digite 0 ou VOLTAR.'; }
  await store.setSession(phone, 'menu'); return `Não entendi.\n\n${menu(c)}`;
}

export async function handleInternal({ phone, text, store, env, c }) {
  const input = String(text || '').trim();
  if (!input || input.toLowerCase() === 'menu') return `Painel da equipe - ${c.name}\n\n1 produto esgotado\n2 tempo cozinha\n3 entrada/saída\n4 manutenção/estoque\n5 incidente\n6 resumo\n7 pedido atrasado\n\nPedidos: preparando 123, pronto 123, saiu 123, entregue 123\nUse: /equipe comando detalhes`;
  const normalized = input.replace(/^\//, '').replace(/^equipe\s*/i, '').trim();
  const [rawCommand, ...rest] = normalized.split(/\s+/);
  const command = rawCommand.toLowerCase();
  if (['preparando', 'saiu', 'pronto', 'entregue'].includes(command)) return updateOrder({ command, rest, store, env });
  if (command === 'menu') return 'Comandos: preparando 123, pronto 123 (retirada), saiu 123 (entrega), entregue 123, resumo. Status não confirma pagamento.';
  const details = rest.join(' ');
  if (command === 'esgotado') { await store.log(phone, 'produto_esgotado', details); return `Produto marcado como esgotado: ${details}`; }
  if (command === 'cozinha') { await store.log(phone, 'tempo_cozinha', details); return `Tempo da cozinha atualizado: ${details} minutos.`; }
  if (command === 'funcionario' || command === 'entrada' || command === 'saida') { await store.log(phone, command, details); return 'Registro de funcionário salvo.'; }
  if (command === 'manutencao' || command === 'estoque') { await store.log(phone, command, details); return `Solicitação registrada: ${details}`; }
  if (command === 'incidente') {
    const severity = ['critico','alto','medio','baixo'].includes(rest[0]?.toLowerCase()) ? rest.shift().toLowerCase() : 'medio';
    await store.createIncident({ phone, severity, description: rest.join(' ') || 'Sem descrição' });
    return `Incidente ${severity} registrado e encaminhado ao responsável.`;
  }
  if (command === 'resumo') { const d = await store.dashboard(); return `Resumo: ${d.orders.length} pedidos recentes, ${d.reservations.length} reservas, ${d.waitlist.length} aguardando e ${d.incidents.length} incidentes abertos.`; }
  if (command === 'atrasado') { await store.log(phone, 'pedido_atrasado', details); return `Alerta de pedido atrasado registrado: ${details}`; }
  return 'Comando não reconhecido. Envie /equipe menu.';
}
