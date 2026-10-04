export function configured(value) { return Boolean(String(value || '').trim()) && String(value).trim().toLowerCase() !== 'insira aqui'; }

export async function validWebhookSignature(raw, signature, secret) {
  if (!configured(secret) || !/^sha256=[a-f0-9]{64}$/i.test(signature || '')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const bytes = Uint8Array.from(signature.slice(7).match(/../g), pair => parseInt(pair, 16));
  return crypto.subtle.verify('HMAC', key, bytes, raw);
}

export async function adminAuthorized(request, env) {
  const actual = request.headers.get('x-admin-token') || bearer(request.headers.get('authorization'));
  if (!configured(env.ADMIN_TOKEN)) return false;
  if (!actual) {
    const cookie = /(?:^|;\s*)admin_session=([^;]+)/.exec(request.headers.get('cookie') || '')?.[1];
    if (!cookie) return false;
    const [expires, signature] = cookie.split('.');
    const seconds = Math.floor(Date.now() / 1000);
    if (!/^\d+$/.test(expires) || Number(expires) <= seconds || Number(expires) > seconds + 3600) return false;
    return validWebhookSignature(new TextEncoder().encode(`admin:${expires}`), `sha256=${signature}`, env.ADMIN_TOKEN);
  }
  // Reject unequal length before comparing every character; never accept URL tokens.
  if (actual.length !== env.ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index++) diff |= actual.charCodeAt(index) ^ env.ADMIN_TOKEN.charCodeAt(index);
  return diff === 0;
}

export async function adminCookie(env) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.ADMIN_TOKEN), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`admin:${expires}`)));
  const hex = Array.from(signature, value => value.toString(16).padStart(2, '0')).join('');
  return `admin_session=${expires}.${hex}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Strict`;
}

function bearer(value) { return /^Bearer\s+(.+)$/i.exec(value || '')?.[1] || ''; }
