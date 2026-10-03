import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { AppError, type NotificationPayload, type PushSubscriptionData } from '../types.js';

export const MAX_PAYLOAD_BYTES = 3993; // 4096-byte push body minus 86-byte header, delimiter and GCM tag.
const fail = (code: string, message: string, status = 400): AppError => new AppError(code, message, status);
function decode(value: string, length: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail('invalid_push_key', 'Invalid push key.');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== length || bytes.toString('base64url') !== value) throw fail('invalid_push_key', 'Invalid push key.');
  return bytes;
}
export function validatePushEndpoint(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw fail('invalid_push_endpoint', 'Invalid push endpoint.'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || /^[a-z0-9-]+\.push\.services\.mozilla\.com$/.test(host)
    || host === 'web.push.apple.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(host)
    || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (typeof endpoint !== 'string' || endpoint.length > 4096 || url.protocol !== 'https:' || !allowed
    || url.username || url.password || url.port || url.hash || url.pathname === '/') {
    throw fail('invalid_push_endpoint', 'Push endpoint must use an approved browser push service over HTTPS.');
  }
  return url;
}
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const a = octets[0]!, b = octets[1]!, c = octets[2]!;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 2) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  // Accept only globally routable unicast IPv6; mapped IPv4, ULA and link-local are excluded.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address)
    && !/^2001:(?:0:|db8:|[12][0-9a-f]:)/i.test(address) && !/^2002:/i.test(address);
}
export function validateSubscription(input: unknown): PushSubscriptionData {
  if (!input || typeof input !== 'object') throw fail('invalid_push_subscription', 'Invalid push subscription.');
  const value = input as Record<string, unknown>;
  if (typeof value.endpoint !== 'string' || !value.keys || typeof value.keys !== 'object') throw fail('invalid_push_subscription', 'Invalid push subscription.');
  const keys = value.keys as Record<string, unknown>;
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') throw fail('invalid_push_subscription', 'Invalid push subscription.');
  const subscription = { endpoint: value.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
  validatePushEndpoint(subscription.endpoint);
  decode(subscription.keys.auth, 16);
  const publicKey = decode(subscription.keys.p256dh, 65);
  try { const ecdh = createECDH('prime256v1'); ecdh.generateKeys(); ecdh.computeSecret(publicKey); }
  catch { throw fail('invalid_push_key', 'Invalid push public key.'); }
  return subscription;
}
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

// Deterministic inputs are exposed for the permanent RFC 8291 Appendix A regression test.
// Production callers omit them and receive a fresh ephemeral key and salt for every message.
export function encryptPush(payload: Buffer, p256dh: string, auth: string,
  inputs?: { privateKey: Buffer; salt: Buffer }): { body: Buffer; sharedSecret: Buffer; prkKey: Buffer; ikm: Buffer; prk: Buffer; cek: Buffer; nonce: Buffer } {
  if (payload.length > MAX_PAYLOAD_BYTES) throw fail('push_payload_too_large', 'Push payload exceeds the 3993-byte limit.');
  const ua = decode(p256dh, 65), secret = decode(auth, 16);
  const ecdh = createECDH('prime256v1');
  if (inputs) ecdh.setPrivateKey(inputs.privateKey); else ecdh.generateKeys();
  const salt = inputs?.salt ?? randomBytes(16);
  if (salt.length !== 16) throw fail('invalid_push_salt', 'Invalid encryption salt.');
  let sharedSecret: Buffer;
  try { sharedSecret = ecdh.computeSecret(ua); } catch { throw fail('invalid_push_key', 'Invalid push public key.'); }
  const as = ecdh.getPublicKey();
  const prkKey = hmac(secret, sharedSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua, as, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const header = Buffer.alloc(86);
  salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = 65; as.copy(header, 21);
  const body = Buffer.concat([header, cipher.update(payload), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  return { body, sharedSecret, prkKey, ikm, prk, cek, nonce };
}
export function createVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}
export function createVapidAuthorization(endpoint: URL, keys: { publicKey: string; privateKey: string }, subject: string): string {
  let contact: URL;
  try { contact = new URL(subject); } catch { throw fail('invalid_vapid_subject', 'VAPID subject must be a mailto or HTTPS URI.'); }
  if (!['mailto:', 'https:'].includes(contact.protocol) || contact.username || contact.password || /[\r\n]/.test(subject)) {
    throw fail('invalid_vapid_subject', 'VAPID subject must be a mailto or HTTPS URI.');
  }
  const pub = decode(keys.publicKey, 65), priv = decode(keys.privateKey, 32);
  const ecdh = createECDH('prime256v1');
  try { ecdh.setPrivateKey(priv); } catch { throw fail('invalid_vapid_key', 'Invalid VAPID key.'); }
  if (!ecdh.getPublicKey().equals(pub)) throw fail('invalid_vapid_key', 'VAPID key pair does not match.');
  const key = createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url'), d: keys.privateKey } });
  const token = `${Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url')}.${Buffer.from(JSON.stringify({ aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })).toString('base64url')}`;
  const signature = sign('sha256', Buffer.from(token), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `vapid t=${token}.${signature}, k=${keys.publicKey}`;
}
export async function sendPush(subscription: PushSubscriptionData, payload: NotificationPayload,
  keys: { publicKey: string; privateKey: string }, subject: string): Promise<{ status: number }> {
  const endpoint = validatePushEndpoint(subscription.endpoint);
  const { body } = encryptPush(Buffer.from(JSON.stringify(payload)), subscription.keys.p256dh, subscription.keys.auth);
  const authorization = createVapidAuthorization(endpoint, keys, subject);
  let addresses: LookupAddress[];
  try { addresses = await lookup(endpoint.hostname, { all: true }); }
  catch { throw fail('push_network_error', 'Push service could not be reached.', 502); }
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) throw fail('invalid_push_endpoint', 'Push service resolved to a non-public address.');
  const address = addresses[0]!;
  // Pin the validated DNS result to the TLS connection, preserving the hostname for SNI/certificate checks.
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number }>();
    const req = request(endpoint, { method: 'POST', agent: false, servername: endpoint.hostname,
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: { Authorization: authorization, TTL: '3600', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
    }, response => {
      const status = response.statusCode ?? 502;
      response.destroy();
      if (status >= 200 && status < 300) resolve({ status });
      else if (status === 404 || status === 410) reject(fail('push_subscription_expired', 'Push subscription has expired.', status));
      else if (status >= 300 && status < 400) reject(fail('push_redirect_rejected', 'Push service redirects are not permitted.', 502));
      else reject(fail('push_service_error', `Push service rejected delivery (HTTP ${status}).`, status === 429 ? 429 : 502));
    });
    const deadline = setTimeout(() => req.destroy(fail('push_network_error', 'Push delivery timed out.', 502)), 15_000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', () => reject(fail('push_network_error', 'Push delivery failed.', 502)));
    req.end(body);
  return promise;
}
