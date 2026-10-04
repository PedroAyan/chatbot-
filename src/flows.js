import { handleOrder, updateOrder } from './orders.js';

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
9 - Cadastro de aniversário
10 - Alergias e restrições alimentares
11 - Solicitar orçamento para evento
0 - Voltar ao menu`;

const numericId = value => /^[1-9]\d*$/.test(String(value || '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const changed = result => result === true || result?.meta?.changes === 1;

async function notifyTeam(store, c, text, kind, reference) {
  for (const phone of new Set(c.internalNumbers || [])) {
    await store.enqueueNotification(phone, text.slice(0, 900), { kind, reference: String(reference) });
  }
}

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

  if (session.state === 'section_human') {
    const existing = session.data.handoffId ? await store.getHandoff(session.data.handoffId) : null;
    if (!existing || existing.status === 'resolved') {
      const id = await store.createHandoff({ phone, name: name || 'Cliente', text: input });
      await store.setSession(phone, 'section_human', { handoffId: id });
      await notifyTeam(store, c, `Atendimento humano #${id} solicitado por ${name || 'Cliente'} (${phone}). Use /equipe assumir ${id}, responder ${id} mensagem ou concluir ${id}.`, 'handoff_request', id);
      return `Solicitação de atendimento #${id} registrada para a equipe. As próximas mensagens serão adicionadas à solicitação enquanto aguarda atendimento.`;
    }
    await store.appendHandoff(phone, input);
    return `Mensagem registrada na solicitação de atendimento #${session.data.handoffId}. A equipe poderá responder por aqui.`;
  }

  if (n === '0' || n === 'voltar') {
    await store.setSession(phone, 'menu'); return menu(c);
  }
  if ((session.state === 'menu' && n === '8') || ['atendente', 'humano', 'falar com atendente', 'falar com humano'].includes(n)) {
    const id = await store.createHandoff({ phone, name: name || 'Cliente', text: input });
    await store.setSession(phone, 'section_human', { handoffId: id });
    await notifyTeam(store, c, `Atendimento humano #${id} solicitado por ${name || 'Cliente'} (${phone}). Use /equipe assumir ${id}, responder ${id} mensagem ou concluir ${id}.`, 'handoff_request', id);
    return `Solicitação de atendimento #${id} registrada para a equipe. As próximas mensagens serão adicionadas à solicitação enquanto aguarda atendimento.`;
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
    await notifyTeam(store, c, `Nova reserva #${id}: ${input}, ${session.data.date} às ${session.data.time}, ${session.data.guests} pessoas. Use /equipe confirmar reserva ${id} para confirmar.`, 'reservation_request', id);
    return `Reserva #${id} recebida para ${session.data.date} às ${session.data.time}, para ${session.data.guests} pessoas. Está pendente da confirmação da equipe.\n\nDigite MINHAS RESERVAS para consultar ou 0 para voltar ao menu.`;
  }
  if (session.state === 'waitlist') {
    const guests = Number(input);
    if (!Number.isInteger(guests) || guests < 1) return 'Informe um número válido de pessoas.';
    const id = await store.createWaitlist({ phone, name: name || 'Cliente', guests });
    const waiting = await store.waitlistStatus();
    await store.setSession(phone, 'section_waitlist');
    await notifyTeam(store, c, `Novo grupo na lista de espera #${id}: ${name || 'Cliente'}, ${guests} pessoas. Use /equipe chamar ${id} quando houver uma mesa.`, 'waitlist_request', id);
    return `Você entrou na lista de espera. Agora há ${waiting.people_count} ${waiting.people_count === 1 ? 'pessoa' : 'pessoas'} em ${waiting.groups_count} ${waiting.groups_count === 1 ? 'grupo' : 'grupos'}. A equipe poderá chamar seu grupo por aqui.\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
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
    const id = await store.createEvent({ phone, name: name || 'Cliente', date: `${session.data.date} ${session.data.time}`, timezone: c.timezone, guests: session.data.guests, details });
    await store.setSession(phone, 'section_event');
    await notifyTeam(store, c, `Novo orçamento de evento #${id}: ${name || 'Cliente'}, ${session.data.date} às ${session.data.time}, ${session.data.guests} pessoas. Detalhes: ${details || 'Sem detalhes'}.`, 'event_request', id);
    return `Solicitação de evento registrada para ${session.data.date} às ${session.data.time}, com ${session.data.guests} pessoas. O orçamento depende da análise da equipe.\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
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
    return `Cadastro de aniversário recebido para ${session.data.name}, em ${birthdate}. Benefícios ou descontos dependem de confirmação da equipe.\n\nDigite 0 ou VOLTAR para retornar ao menu.`;
  }
  if (session.state === 'allergy_details') {
    if (input.length < 2) return 'Descreva sua alergia ou restrição. Para sair, digite 0 ou VOLTAR.';
    await store.log(phone, 'alergia_restricao', input);
    await notifyTeam(store, c, `Alergia ou restrição informada pelo cliente ${phone}: ${input}. Confirme os ingredientes antes do preparo.`, 'allergy_request', phone);
    await store.setSession(phone, 'section_allergies');
    return 'Informação registrada. A equipe deverá confirmar os ingredientes antes do preparo.\n\nDigite 0 ou VOLTAR para retornar ao menu.';
  }

  if ((session.state === 'menu' || session.state === 'section_reservation') && n.startsWith('cancelar reserva')) {
    const id = numericId(n.match(/^cancelar reserva\s+([1-9]\d*)$/)?.[1]);
    if (!id) return 'Informe o número da reserva. Exemplo: CANCELAR RESERVA 123';
    const result = await store.cancelReservation(phone, id);
    await store.setSession(phone, 'section_reservation');
    if (!changed(result)) return `A reserva #${id} não foi encontrada entre suas reservas ativas.`;
    await notifyTeam(store, c, `O cliente cancelou a reserva #${id}.`, 'reservation_cancelled', id);
    return `Reserva #${id} cancelada.`;
  }
  if ((session.state === 'menu' || session.state === 'section_reservation') && n.startsWith('alterar reserva')) {
    const id = numericId(n.match(/^alterar reserva\s+([1-9]\d*)$/)?.[1]);
    if (!id) return 'Informe o número da reserva. Exemplo: ALTERAR RESERVA 123';
    const reservation = await store.getReservation(id);
    if (!reservation || reservation.phone !== phone || !['pending', 'confirmed'].includes(reservation.status)) return `A reserva #${id} não foi encontrada entre suas reservas ativas.`;
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
    const result = await store.updateReservation(phone, session.data.id, session.data.date, session.data.time, guests);
    await store.setSession(phone, 'section_reservation');
    if (!changed(result)) return `A reserva #${session.data.id} não foi encontrada entre suas reservas ativas.`;
    await notifyTeam(store, c, `Reserva #${session.data.id} alterada pelo cliente para ${session.data.date} às ${session.data.time}, ${guests} pessoas. Confirme novamente a disponibilidade.`, 'reservation_changed', `${session.data.id}:${session.data.date}:${session.data.time}:${guests}`);
    return `Reserva #${session.data.id} atualizada para ${session.data.date} às ${session.data.time}, ${guests} pessoas. A disponibilidade precisa ser confirmada novamente pela equipe. Digite 0 ou VOLTAR para retornar ao menu.`;
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
    const available = await store.availableProducts(c.products || []);
    if (available.some(product => (product.category || 'food') === 'food')) {
      const products = available.filter(product => (product.category || 'food') === 'food').map(product => `${product.id} — ${product.name}: ${product.package ? 'a partir de ' : ''}${(product.priceCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`).join('\n');
      const link = c.menuUrl && !c.menuUrl.includes('example.com') ? `\n\nCardápio completo: ${c.menuUrl}` : '';
      return `🎉 Buffets para festas\n\n${products}${link}\n\nEscolha 1 buffet. Depois você selecionará 50, 100, 200, 500 ou 1.000 convidados, adicionais por cento e bebidas. Valores estimados sujeitos à confirmação da equipe.`;
    }
    return 'Não há produtos disponíveis no cardápio de pedidos. Digite 0 para voltar ao menu e 8 para falar com um atendente.';
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
  if (n === '9' || n.includes('fidel') || n.includes('cupom') || n.includes('anivers')) { await store.setSession(phone, 'loyalty_name'); return 'Podemos registrar seu aniversário. Pontos e cupons ainda não estão disponíveis no bot. Informe seu nome completo. Para sair, digite 0 ou VOLTAR.'; }
  if (n === '10' || n.includes('alerg') || n.includes('restri')) { await store.setSession(phone, 'allergy_details'); return 'Informe suas alergias ou restrições. A equipe confirmará os ingredientes antes do preparo. Para sair, digite 0 ou VOLTAR.'; }
  if (n === '11' || n === 'evento' || n === 'eventos' || n === 'orçamento de evento' || n === 'orcamento de evento') { await store.setSession(phone, 'event_datetime'); return 'Informe a data e o horário do evento no formato DD/MM/AAAA HH:MM.'; }
  await store.setSession(phone, 'menu'); return `Não entendi.\n\n${menu(c)}`;
}

export async function handleInternal({ phone, text, store, env, c }) {
  const input = String(text || '').trim();
  const help = `Painel da equipe - ${c.name}\n\nPedidos: preparando ID, pronto ID (retirada), saiu ID (entrega), entregue ID\nProdutos: esgotado ID, disponivel ID\nTempo: cozinha MINUTOS\nAtendimento: assumir ID, responder ID mensagem, concluir ID\nLista de espera: chamar ID, retirar ID\nReservas: confirmar reserva ID, notificar reserva ID mensagem\nOutros: entrada, saida, manutencao, estoque, incidente, resumo, atrasado\nUse: /equipe comando detalhes. Avisos são encaminhados para envio e não confirmam pagamento.`;
  if (!input || input.toLowerCase() === 'menu') return help;
  const normalized = input.replace(/^\//, '').replace(/^equipe\s*/i, '').trim();
  const [rawCommand, ...rest] = normalized.split(/\s+/);
  const command = rawCommand.toLowerCase();
  if (['preparando', 'saiu', 'pronto', 'entregue'].includes(command)) return updateOrder({ command, rest, store, env });
  if (command === 'menu') return help;
  const details = rest.join(' ');
  if (['esgotado', 'disponivel', 'disponível'].includes(command)) {
    const id = rest.length === 1 ? numericId(rest[0]) : null;
    const product = c.products.find(item => item.id === id);
    if (!product) return `Use: ${command} ID. Informe um código existente no cardápio.`;
    const available = command !== 'esgotado';
    await store.setProductAvailability(id, available);
    await store.log(phone, available ? 'produto_disponivel' : 'produto_esgotado', String(id));
    return `${product.name} (#${id}) ${available ? 'disponível para novos pedidos' : 'esgotado e retirado das opções de novos pedidos'}.`;
  }
  if (command === 'cozinha') {
    const minutes = rest.length === 1 && /^\d+$/.test(rest[0]) ? Number(rest[0]) : 0;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return 'Use: cozinha MINUTOS. Informe um inteiro entre 1 e 1440.';
    await store.setSetting('kitchen_minutes', String(minutes));
    await store.log(phone, 'tempo_cozinha', String(minutes));
    return `Tempo estimado de preparo atualizado para ${minutes} minutos nos próximos pedidos.`;
  }
  if (['assumir', 'responder', 'concluir'].includes(command)) {
    const id = numericId(rest[0]);
    if (!id || (command !== 'responder' && rest.length !== 1) || (command === 'responder' && rest.length < 2)) return `Use: ${command} ID${command === 'responder' ? ' mensagem' : ''}`;
    const ticket = await store.getHandoff(id);
    if (!ticket || ticket.status === 'resolved') return 'Atendimento ativo não encontrado.';
    if (command === 'assumir') {
      if (ticket.status === 'assigned') return `Atendimento #${id} já está em andamento.`;
      if (!changed(await store.setHandoffStatus(id, 'assigned'))) return 'O atendimento mudou. Consulte novamente.';
      await store.log(phone, 'atendimento_assumido', String(id));
      await store.enqueueNotification(ticket.phone, `A equipe assumiu seu atendimento #${id}. Você pode enviar mais detalhes por aqui.`, { kind: 'handoff_assigned', reference: String(id) });
      return `Atendimento #${id} assumido. Aviso encaminhado para envio.`;
    }
    if (command === 'responder') {
      const message = rest.slice(1).join(' ');
      if (message.length > 800) return 'A resposta deve ter no máximo 800 caracteres. Divida o texto em mensagens menores.';
      await store.enqueueNotification(ticket.phone, `Atendimento #${id} — Equipe: ${message}`, { kind: 'handoff_reply', reference: `${id}:${message}` });
      await store.log(phone, 'resposta_atendimento', JSON.stringify({ id, message }));
      return `Resposta do atendimento #${id} encaminhada para envio.`;
    }
    if (!changed(await store.setHandoffStatus(id, 'resolved'))) return 'O atendimento mudou. Consulte novamente.';
    await store.setSession(ticket.phone, 'menu');
    await store.log(phone, 'atendimento_concluido', String(id));
    await store.enqueueNotification(ticket.phone, `Atendimento #${id} concluído pela equipe. Envie MENU para acessar o assistente novamente.`, { kind: 'handoff_resolved', reference: String(id) });
    return `Atendimento #${id} concluído. Assistente liberado e aviso encaminhado para envio.`;
  }
  if (['chamar', 'retirar'].includes(command)) {
    const id = rest.length === 1 ? numericId(rest[0]) : null;
    if (!id) return `Use: ${command} ID`;
    const waiting = await store.getWaitlist(id);
    if (!waiting || !['waiting', 'called'].includes(waiting.status)) return 'Grupo ativo não encontrado na lista de espera.';
    if (command === 'chamar' && waiting.status !== 'waiting') return `O grupo #${id} já foi chamado.`;
    const status = command === 'chamar' ? 'called' : 'removed';
    if (!changed(await store.setWaitlistStatus(id, waiting.status, status))) return 'A lista mudou. Consulte novamente.';
    const message = command === 'chamar' ? `Lista de espera #${id}: a equipe chamou seu grupo. Apresente-se ao atendimento para ocupar a mesa.` : `Seu grupo #${id} foi retirado da lista de espera pela equipe.`;
    await store.enqueueNotification(waiting.phone, message, { kind: 'waitlist_status', reference: `${id}:${status}` });
    await store.log(phone, 'lista_espera_status', JSON.stringify({ id, status }));
    return `Grupo #${id} ${command === 'chamar' ? 'chamado' : 'retirado da lista'}. Aviso encaminhado para envio.`;
  }
  if (['confirmar', 'notificar'].includes(command)) {
    if (rest[0]?.toLowerCase() !== 'reserva') return `Use: ${command} reserva ID${command === 'notificar' ? ' mensagem' : ''}`;
    const id = numericId(rest[1]);
    if (!id || (command === 'confirmar' && rest.length !== 2) || (command === 'notificar' && rest.length < 3)) return `Use: ${command} reserva ID${command === 'notificar' ? ' mensagem' : ''}`;
    const reservation = await store.getReservation(id);
    if (!reservation || !['pending', 'confirmed'].includes(reservation.status)) return 'Reserva ativa não encontrada.';
    if (command === 'confirmar') {
      if (reservation.status === 'confirmed') return `Reserva #${id} já está confirmada. Use notificar reserva ${id} mensagem para enviar outro aviso.`;
      if (!changed(await store.setReservationStatus(id, 'pending', 'confirmed'))) return 'A reserva mudou. Consulte novamente.';
      await store.enqueueNotification(reservation.phone, `Reserva #${id} confirmada para ${reservation.date} às ${reservation.time}, ${reservation.guests} pessoas.`, { kind: 'reservation_confirmed', reference: `${id}:${reservation.date}:${reservation.time}:${reservation.guests}` });
      return `Reserva #${id} confirmada. Aviso encaminhado para envio.`;
    }
    const message = rest.slice(2).join(' ');
    if (message.length > 800) return 'O aviso deve ter no máximo 800 caracteres. Divida o texto em mensagens menores.';
    await store.enqueueNotification(reservation.phone, `Reserva #${id} — Equipe: ${message}`, { kind: 'reservation_message', reference: `${id}:${message}` });
    return `Aviso da reserva #${id} encaminhado para envio.`;
  }
  if (command === 'funcionario' || command === 'entrada' || command === 'saida') { await store.log(phone, command, details); return 'Registro de funcionário salvo.'; }
  if (command === 'manutencao' || command === 'estoque') { await store.log(phone, command, details); return `Solicitação registrada: ${details}`; }
  if (command === 'incidente') {
    const severity = ['critico','alto','medio','baixo'].includes(rest[0]?.toLowerCase()) ? rest.shift().toLowerCase() : 'medio';
    await store.createIncident({ phone, severity, description: rest.join(' ') || 'Sem descrição' });
    return `Incidente ${severity} registrado no painel da equipe.`;
  }
  if (command === 'resumo') { const d = await store.dashboard(); return `Resumo: ${d.orders.length} pedidos recentes, ${d.reservations.length} reservas, ${d.waitlist.length} aguardando e ${d.incidents.length} incidentes abertos.`; }
  if (command === 'atrasado') { await store.log(phone, 'pedido_atrasado', details); return `Alerta de pedido atrasado registrado: ${details}`; }
  return 'Comando não reconhecido. Envie /equipe menu.';
}
