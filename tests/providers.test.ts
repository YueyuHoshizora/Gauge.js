import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LoginManager } from '../src/auth/index.js';
import { parseClaudeUsage } from '../src/providers/claude.js';
import { parseCodexUsage } from '../src/providers/codex.js';
import { parseGrokUsage } from '../src/providers/grok.js';
import { parseAntigravityUsage, parseAntigravityModels } from '../src/providers/antigravity.js';
import { getProvider } from '../src/providers/index.js';
import { request, tokens } from '../src/providers/common.js';
import { AppError, type Auth } from '../src/types.js';

const validAuth: Auth = { type: 'oauth', accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: Date.now() + 3_600_000, extra: { accountId: 'tenant-123' } };

test('Claude preserves confirmed zero, optional windows, null resets, and rejects missing utilization', () => {
  const result = parseClaudeUsage({ five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: '47.5', resets_at: '2026-10-10T12:00:00Z' }, seven_day_opus: null });
  assert.equal(result.windows.length, 2); assert.equal(result.windows[0]?.remainingPct, 100); assert.equal(result.windows[0]?.resetsAt, null); assert.equal(result.windows[1]?.remainingPct, 52.5);
  assert.throws(() => parseClaudeUsage({ five_hour: { resets_at: null } }), { code: 'UPSTREAM_SCHEMA' });
  assert.throws(() => parseClaudeUsage({}), { code: 'UPSTREAM_SCHEMA' });
});
test('Codex reads actual primary_window fields, additional limits, numeric credits, and legacy shape', () => {
  const result = parseCodexUsage({ plan_type: 'plus', rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_800_000_000 }, secondary_window: { used_percent: 120, limit_window_seconds: 604_800, reset_at: null } }, additional_rate_limits: [{ metered_feature: 'review', limit_name: 'Code review', rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 3600 } } }], credits: { balance: '12.25' } });
  assert.equal(result.windows[0]?.label, '300 minutes'); assert.equal(result.windows[0]?.resetsAt, new Date(1_800_000_000_000).toISOString()); assert.equal(result.windows[1]?.remainingPct, 0); assert.equal(result.windows[2]?.remainingPct, 100); assert.equal(result.meta.credits, 12.25);
  assert.equal(parseCodexUsage({ rate_limit: { primary: { used_percent: '9', window_minutes: 300, resets_at: 1_800_000_000 } } }).windows[0]?.remainingPct, 91);
  assert.throws(() => parseCodexUsage({ credits: { balance: 0 } }), { code: 'UPSTREAM_SCHEMA' });
});
test('Grok reads root/config percentages and never fabricates zero for missing or zero-cap billing', () => {
  assert.equal(parseGrokUsage({ creditUsagePercent: 0, config: { creditUsagePercent: 50 } }).windows[0]?.remainingPct, 100);
  assert.equal(parseGrokUsage({ config: { creditUsagePercent: 25, currentPeriod: { end: '2026-10-10T12:00:00Z' } } }).windows[0]?.remainingPct, 75);
  const fallback = parseGrokUsage({ config: { onDemandUsed: { val: 25 }, onDemandCap: { val: 100 }, billingPeriodEnd: '2026-10-10T12:00:00Z' } });
  assert.equal(fallback.windows[0]?.remainingPct, 75); assert.equal(fallback.windows[0]?.approximate, true); assert.equal(fallback.windows[0]?.key, 'on_demand');
  for (const value of [{ config: { currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY' } } }, { onDemandUsed: { val: 0 }, onDemandCap: { val: 0 } }, { creditUsagePercent: '' }]) assert.throws(() => parseGrokUsage(value), { code: 'UPSTREAM_SCHEMA' });
});
test('Antigravity treats only REQUESTS buckets as authoritative and labels shared Vertex estimates', () => {
  const result = parseAntigravityUsage({ buckets: [{ modelId: 'gemini-pro', tokenType: 'REQUESTS', remainingFraction: 0.125, resetTime: '2026-10-10T12:00:00Z' }, { modelId: 'gemini-pro', tokenType: 'TOKENS', remainingFraction: 0.75 }] });
  assert.equal(result.windows.length, 1); assert.equal(result.windows[0]?.remainingPct, 12.5); assert.equal(result.windows[0]?.approximate, undefined);
  const estimates = parseAntigravityModels({ models: { 'claude-sonnet': { quotaInfo: { remainingFraction: 0.5 } }, 'gemini-pro': { quotaInfo: { remainingFraction: 1 } }, 'gpt-bad': { quotaInfo: {} } } });
  assert.equal(estimates.length, 1); assert.equal(estimates[0]?.approximate, true);
  assert.throws(() => parseAntigravityUsage({ buckets: [{ modelId: 'x', tokenType: 'REQUESTS' }] }), { code: 'UPSTREAM_SCHEMA' });
});
test('refresh returns newest complete token bundle without mutating old credentials or losing metadata', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => { calls.push(url.href); assert.equal(init.redirect, 'error'); return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }); });
  for (const id of ['claude', 'codex', 'grok', 'antigravity'] as const) {
    const result = await getProvider(id).refresh(validAuth);
    assert.equal(result.refreshToken, 'rotated-refresh'); assert.equal(result.accessToken, 'new-access'); assert.equal(result.extra.accountId, 'tenant-123'); assert.ok(result.expiresAt > Date.now());
  }
  assert.equal(calls.length, 4); assert.equal(validAuth.refreshToken, 'old-refresh');
  assert.equal(tokens({ access_token: 'new-access', expires_in: 3600 }, validAuth).refreshToken, 'old-refresh');
});
test('upstream destinations and error responses are safe; no response body secrets escape', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: 'invalid_grant', error_description: 'private-refresh' }, { status: 400 }); });
  await assert.rejects(request('https://example.com/oauth/token'), { code: 'UPSTREAM_ERROR' }); assert.equal(calls, 0);
  await assert.rejects(getProvider('codex').refresh(validAuth), error => error instanceof AppError && error.code === 'AUTH_EXPIRED' && !error.message.includes('private-refresh'));
});
test('paste sessions require matching state and provider, supersede same-account attempts, and wipe private fields', async t => {
  const saved: string[] = [];
  const manager = new LoginManager({ cloud: true, port: 8787, onAuth: accountId => { saved.push(accountId); } });
  t.after(() => manager.close());
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ access_token: 'sensitive-access', refresh_token: 'sensitive-refresh', expires_in: 3600 }); });
  const a = await manager.start('claude', 'account-a'); const b = await manager.start('claude', 'account-b');
  const stateA = new URL(a.authorizationUrl!).searchParams.get('state')!; const stateB = new URL(b.authorizationUrl!).searchParams.get('state')!;
  assert.notEqual(stateA, stateB);
  await assert.rejects(manager.complete('claude', a.id, `code#${stateB}`), { code: 'LOGIN_STATE' });
  await assert.rejects(manager.complete('codex', a.id, `code#${stateA}`), { code: 'LOGIN_NOT_FOUND' });
  await assert.rejects(manager.complete('claude', a.id, 'bare-code'), { code: 'LOGIN_INPUT' });
  assert.equal(calls, 0);
  const done = await manager.complete('claude', a.id, `code#${stateA}`); assert.equal(done.status, 'complete'); assert.deepEqual(saved, ['account-a']);
  assert.equal(JSON.stringify(done).includes('sensitive'), false); assert.equal('verifier' in done, false);
  await assert.rejects(manager.complete('claude', a.id, `code#${stateA}`), { code: 'LOGIN_EXPIRED' });
  await manager.start('claude', 'account-b'); assert.equal(manager.status('claude', b.id).error, 'LOGIN_CANCELLED');
  await assert.rejects(manager.start('claude', 'account-c', 'device'), { code: 'LOGIN_MODE' });
  await assert.rejects(manager.callback('claude', new URLSearchParams({ state: stateA, code: 'x' })), { code: 'LOGIN_MODE' });
});
test('expiry invalidates paste state before any exchange', async t => {
  const manager = new LoginManager({ cloud: true, port: 8787, onAuth: () => { assert.fail('expired session persisted'); } }); t.after(() => manager.close());
  const login = await manager.start('antigravity', 'account'); const state = new URL(login.authorizationUrl!).searchParams.get('state')!;
  t.mock.method(Date, 'now', () => login.expiresAt + 1);
  assert.equal(manager.status('antigravity', login.id).error, 'LOGIN_EXPIRED');
  await assert.rejects(manager.complete('antigravity', login.id, `code#${state}`), { code: 'LOGIN_EXPIRED' });
});
test('Codex device flow uses proprietary endpoints, waits on 403, verifies server PKCE, and exchanges code', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const verifier = 'device-flow-verifier'; const challenge = createHash('sha256').update(verifier).digest('base64url'); let polls = 0;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    calls.push(url.href);
    if (url.pathname.endsWith('/usercode')) return Response.json({ device_auth_id: 'device-id', user_code: 'ABCD-EFGH', interval: '1' });
    if (url.pathname.endsWith('/deviceauth/token')) { polls++; if (polls === 1) return Response.json({}, { status: 403 }); return Response.json({ authorization_code: 'device-authorization', code_verifier: verifier, code_challenge: challenge }); }
    const body = new URLSearchParams(String(init.body)); assert.equal(body.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback'); assert.equal(body.get('code_verifier'), verifier);
    return Response.json({ access_token: 'device-access', refresh_token: 'device-refresh', expires_in: 3600 });
  });
  let resolve!: (value: Auth) => void; const finished = new Promise<Auth>(done => { resolve = done; });
  const manager = new LoginManager({ cloud: true, port: 8787, onAuth: (_accountId, auth) => { resolve(auth); } }); t.after(() => manager.close());
  const login = await manager.start('codex', 'account'); assert.equal(login.mode, 'device'); assert.equal(login.verificationUri, 'https://auth.openai.com/codex/device'); assert.equal(login.userCode, 'ABCD-EFGH');
  t.mock.timers.tick(1000); await new Promise<void>(done => setImmediate(done)); assert.equal(polls, 1);
  t.mock.timers.tick(1000); await new Promise<void>(done => setImmediate(done)); assert.equal(polls, 2);
  const auth = await finished;
  assert.equal(auth.refreshToken, 'device-refresh'); assert.equal(calls[0], 'https://auth.openai.com/api/accounts/deviceauth/usercode');
  assert.equal(manager.status('codex', login.id).status, 'complete');
});

test('Grok RFC8628 pending and slow_down delay subsequent polls; explicit Codex denial is terminal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const manager = new LoginManager({ cloud: true, port: 8787, onAuth: () => assert.fail('denied login persisted') }); t.after(() => manager.close());
  let grokPolls = 0;
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    if (url.pathname.endsWith('/usercode')) return Response.json({ device_auth_id: 'codex-device', user_code: 'CODEX', interval: 1 });
    if (url.pathname.endsWith('/device/code')) return Response.json({ device_code: 'grok-device', user_code: 'GROK', verification_uri: 'https://auth.x.ai/device', interval: 1, expires_in: 600 });
    if (url.hostname === 'auth.openai.com') return Response.json({ error: 'access_denied' }, { status: 403 });
    grokPolls++; return Response.json({ error: grokPolls === 1 ? 'authorization_pending' : grokPolls === 2 ? 'slow_down' : 'expired_token' }, { status: 400 });
  });
  const grok = await manager.start('grok', 'grok-account'); const codex = await manager.start('codex', 'codex-account');
  t.mock.timers.tick(1000); await new Promise<void>(done => setImmediate(done));
  assert.equal(grokPolls, 1); assert.equal(manager.status('codex', codex.id).error, 'LOGIN_DENIED');
  t.mock.timers.tick(1000); await new Promise<void>(done => setImmediate(done)); assert.equal(grokPolls, 2);
  t.mock.timers.tick(5999); await new Promise<void>(done => setImmediate(done)); assert.equal(grokPolls, 2);
  t.mock.timers.tick(1); await new Promise<void>(done => setImmediate(done)); assert.equal(grokPolls, 3);
  assert.equal(manager.status('grok', grok.id).error, 'LOGIN_EXPIRED');
});

test('Grok accepts its official accounts portal, preserves the full device lifetime, and rejects foreign origins', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const manager = new LoginManager({ cloud: true, port: 8787, onAuth: () => assert.fail('pending login persisted') }); t.after(() => manager.close());
  let verification = 'https://accounts.x.ai/device?user_code=TEST-CODE';
  t.mock.method(globalThis, 'fetch', async (url: URL) => url.pathname.endsWith('/device/code')
    ? Response.json({ device_code: 'grok-device', user_code: 'TEST-CODE', verification_uri_complete: verification, interval: 5, expires_in: 1800 })
    : Response.json({ error: 'authorization_pending' }, { status: 400 }));
  const login = await manager.start('grok', 'account');
  t.mock.timers.tick(901_000);
  const firstPoll = Promise.withResolvers<void>(); setImmediate(firstPoll.resolve); await firstPoll.promise;
  assert.equal(manager.status('grok', login.id).status, 'pending');
  assert.equal(new URL(manager.status('grok', login.id).verificationUri!).hostname, 'accounts.x.ai');
  t.mock.timers.tick(900_000);
  assert.equal(manager.status('grok', login.id).error, 'LOGIN_EXPIRED');
  for (verification of ['https://accounts.x.ai.evil.invalid/device', 'http://accounts.x.ai/device', 'https://accounts.x.ai:444/device', 'https://user@accounts.x.ai/device']) {
    await assert.rejects(manager.start('grok', 'account'), { code: 'UPSTREAM_SCHEMA' });
  }
});

test('cancelling an in-flight exchange prevents a late token response from persisting', async t => {
  let respond!: (value: Response) => void;
  const response = new Promise<Response>(resolve => { respond = resolve; });
  t.mock.method(globalThis, 'fetch', () => response);
  const manager = new LoginManager({ cloud: true, port: 8787, onAuth: () => assert.fail('cancelled session persisted') }); t.after(() => manager.close());
  const login = await manager.start('claude', 'account'); const state = new URL(login.authorizationUrl!).searchParams.get('state')!;
  const pending = manager.complete('claude', login.id, `code#${state}`);
  manager.cancel('claude', login.id);
  respond(Response.json({ access_token: 'late-access', refresh_token: 'late-refresh', expires_in: 3600 }));
  await assert.rejects(pending, { code: 'LOGIN_EXPIRED' });
  const final = manager.status('claude', login.id);
  assert.equal(final.error, 'LOGIN_CANCELLED'); assert.equal(final.authorizationUrl, undefined);
});
