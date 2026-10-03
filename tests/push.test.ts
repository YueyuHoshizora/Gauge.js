import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createVapidAuthorization, createVapidKeys, encryptPush, isPublicAddress, MAX_PAYLOAD_BYTES, validatePushEndpoint, validateSubscription } from '../src/push/index.js';

// Official RFC 8291 Appendix A: https://www.rfc-editor.org/rfc/rfc8291#appendix-A
// Whitespace in the RFC's wrapped base64url values is removed, with no generated expectations.
const vector = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  sharedSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prkKey: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};
const bytes = (value: string): Buffer => Buffer.from(value, 'base64url');
test('RFC 8291 Appendix A exact intermediate values and encrypted push body', () => {
  const result = encryptPush(bytes(vector.plaintext), vector.uaPublic, vector.auth,
    { privateKey: bytes(vector.asPrivate), salt: bytes(vector.salt) });
  for (const key of ['sharedSecret', 'prkKey', 'ikm', 'prk', 'cek', 'nonce'] as const) {
    assert.equal(result[key].toString('base64url'), vector[key], key);
  }
  assert.equal(result.body.subarray(0, 86).toString('base64url'), vector.header);
  assert.equal(result.body.subarray(86).toString('base64url'), vector.ciphertext);
  assert.deepEqual(result.body, Buffer.concat([bytes(vector.header), bytes(vector.ciphertext)]));
});
test('one-record body bounds and fresh encryption material', () => {
  const result = encryptPush(Buffer.alloc(MAX_PAYLOAD_BYTES), vector.uaPublic, vector.auth);
  assert.equal(result.body.length, 4096);
  assert.throws(() => encryptPush(Buffer.alloc(MAX_PAYLOAD_BYTES + 1), vector.uaPublic, vector.auth), /3993-byte/);
  assert.throws(() => encryptPush(Buffer.from('hello'), vector.uaPublic, 'invalid'), /Invalid push key/);
  assert.notDeepEqual(encryptPush(Buffer.from('hello'), vector.uaPublic, vector.auth).body,
    encryptPush(Buffer.from('hello'), vector.uaPublic, vector.auth).body);
});
test('VAPID JWT uses verifiable ES256, service origin and bounded expiration', () => {
  const keys = createVapidKeys();
  const before = Math.floor(Date.now() / 1000);
  const header = createVapidAuthorization(new URL('https://fcm.googleapis.com/fcm/send/example'), keys, 'mailto:push@example.com');
  const token = header.split(',')[0]!.slice('vapid t='.length);
  const [encodedHeader, encodedClaims, signature] = token.split('.') as [string, string, string];
  assert.deepEqual(JSON.parse(bytes(encodedHeader).toString()), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(bytes(encodedClaims).toString()) as { aud: string; exp: number; sub: string };
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:push@example.com');
  assert.ok(claims.exp >= before + 12 * 3600 && claims.exp <= Math.floor(Date.now() / 1000) + 12 * 3600);
  const pub = bytes(keys.publicKey);
  const key = createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.equal(bytes(signature).length, 64);
  assert.ok(verify('sha256', Buffer.from(`${encodedHeader}.${encodedClaims}`), { key, dsaEncoding: 'ieee-p1363' }, bytes(signature)));
  assert.throws(() => createVapidAuthorization(new URL('https://fcm.googleapis.com'), { ...keys, privateKey: createVapidKeys().privateKey }, 'mailto:a@example.com'), /does not match/);
  assert.throws(() => createVapidAuthorization(new URL('https://fcm.googleapis.com'), keys, 'http://localhost'), /VAPID subject/);
});
test('endpoint allowlist excludes arbitrary URLs and ambiguous authorities', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://web.push.apple.com/a', 'https://wns2.notify.windows.com/w/?token=a']) assert.doesNotThrow(() => validatePushEndpoint(endpoint));
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://localhost/a', 'https://example.com/a', 'https://fcm.googleapis.com.evil.test/a', 'https://user@fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a', 'https://fcm.googleapis.com/a#b', 'https://fcm.googleapis.com/']) assert.throws(() => validatePushEndpoint(endpoint));
});
test('DNS policy rejects private, reserved and mapped addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '142.250.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});
test('subscription validation accepts browser keys and rejects malformed input before storage', () => {
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/a', keys: { p256dh: vector.uaPublic, auth: vector.auth } };
  assert.deepEqual(validateSubscription(subscription), subscription);
  for (const input of [null, {}, { endpoint: subscription.endpoint }, { ...subscription, keys: null }, { ...subscription, keys: { auth: 2, p256dh: vector.uaPublic } }, { ...subscription, keys: { auth: vector.auth, p256dh: Buffer.alloc(65).toString('base64url') } }]) assert.throws(() => validateSubscription(input));
});
