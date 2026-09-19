const API_VERSION = 'v23.0';

async function api(env, payload) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    console.log('WhatsApp não configurado:', JSON.stringify(payload));
    return { simulated: true };
  }

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...payload
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `WhatsApp API ${response.status}: ${await response.text()}`
    );
  }

  const result = await response.json();
  console.log('Resposta enviada pela API:', response.status);
  return result;
}

export function sendText(env, to, body) {
  return api(env, {
    to,
    type: 'text',
    text: {
      preview_url: true,
      body
    }
  });
}

export function sendDocument(env, to, link, filename = 'cardapio.pdf') {
  return api(env, {
    to,
    type: 'document',
    document: { link, filename }
  });
}