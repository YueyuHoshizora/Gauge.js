import { AppError, type Auth, type QuotaWindow } from '../types.js';

const HOSTS: Record<string, true> = { 'auth.openai.com': true, 'chatgpt.com': true, 'claude.ai': true, 'console.anthropic.com': true, 'platform.claude.com': true, 'api.anthropic.com': true, 'auth.x.ai': true, 'cli-chat-proxy.grok.com': true, 'accounts.google.com': true, 'oauth2.googleapis.com': true, 'cloudcode-pa.googleapis.com': true };
export type ObjectValue = Record<string, unknown>;
export function object(value: unknown): ObjectValue { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {}; }
export function text(value: unknown): string | undefined { return typeof value === 'string' && value.length > 0 ? value : undefined; }
export function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const result = Number(value); return Number.isFinite(result) ? result : undefined;
}
export function schema(): never { throw new AppError('UPSTREAM_SCHEMA', 'The provider did not return usable quota or authentication data.', 502); }
export function iso(value: unknown, unixSeconds = false): string | null {
  if (value === undefined || value === null || value === '') return null;
  const n = number(value);
  const date = n !== undefined ? new Date(unixSeconds || n < 1e12 ? n * 1000 : n) : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}
export function window(key: string, label: string, used: unknown, reset: unknown, unixSeconds = false, approximate = false): QuotaWindow {
  const n = number(used); if (n === undefined || n < 0) schema();
  const usedPct = Math.min(100, n);
  return { key, label, usedPct, remainingPct: 100 - usedPct, resetsAt: iso(reset, unixSeconds), ...(approximate ? { approximate: true } : {}) };
}
export interface UpstreamResponse { status: number; data: ObjectValue; retryAfter?: number }
export async function request(url: string, init: RequestInit = {}, signal?: AbortSignal): Promise<UpstreamResponse> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || HOSTS[target.hostname] !== true || target.port || target.username || target.password) throw new AppError('UPSTREAM_ERROR', 'Upstream destination is not permitted.', 502);
  const timeout = AbortSignal.timeout(20_000);
  try {
    const response = await fetch(target, { ...init, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    const retry = response.headers.get('retry-after');
    const retryAfter = retry ? (number(retry) ?? Math.max(0, (Date.parse(retry) - Date.now()) / 1000)) : undefined;
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2_097_152) { await reader.cancel(); schema(); } chunks.push(next.value); }
    }
    let data: ObjectValue = {};
    if (size) { try { data = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { if (response.ok) schema(); } }
    return { status: response.status, data, ...(retryAfter !== undefined && Number.isFinite(retryAfter) ? { retryAfter: Math.min(1800, Math.max(1, retryAfter)) } : {}) };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (timeout.aborted) throw new AppError('UPSTREAM_TIMEOUT', 'The provider request timed out.', 504);
    throw new AppError('UPSTREAM_ERROR', 'The provider request could not be completed.', 502);
  }
}
export function expect(response: UpstreamResponse, token = false): ObjectValue {
  if (response.status >= 200 && response.status < 300) return response.data;
  if (response.status === 429) throw new AppError('RATE_LIMITED', 'The provider is rate limiting requests.', 429, response.retryAfter);
  if (response.status === 401 || (token && ['invalid_grant', 'invalid_token'].includes(String(response.data.error)))) throw new AppError('AUTH_EXPIRED', 'Provider credentials have expired. Sign in again.', 401);
  throw new AppError('UPSTREAM_ERROR', `The provider returned HTTP ${response.status}.`, response.status >= 500 ? 502 : 400);
}
export function json(body: ObjectValue, accessToken?: string): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body) };
}
export function form(body: Record<string, string>): RequestInit { return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(body).toString() }; }
// These TLS-delivered claims are metadata hints, never authorization decisions.
export function claims(jwt: unknown): ObjectValue {
  if (typeof jwt !== 'string' || jwt.length > 32_768) return {};
  try { return object(JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'))); } catch { return {}; }
}
export function tokens(data: ObjectValue, previous?: Auth): Auth {
  const accessToken = text(data.access_token); const refreshToken = text(data.refresh_token) ?? previous?.refreshToken;
  const lifetime = number(data.expires_in); const accessClaims = claims(accessToken); const idClaims = claims(data.id_token);
  const expiresAt = lifetime !== undefined && lifetime > 0 ? Date.now() + lifetime * 1000 : (number(accessClaims.exp) ?? 0) * 1000;
  if (!accessToken || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) schema();
  const authClaims = object(idClaims['https://api.openai.com/auth']);
  const accountId = text(data.account_id) ?? text(authClaims.chatgpt_account_id) ?? text(object(accessClaims['https://api.openai.com/auth']).chatgpt_account_id);
  const email = text(idClaims.email) ?? text(data.email) ?? text(object(data.account).email);
  return { type: 'oauth', accessToken, ...(refreshToken ? { refreshToken } : {}), expiresAt, extra: { ...previous?.extra, ...(accountId ? { accountId } : {}), ...(email ? { email } : {}), ...(text(data.scope) ? { scope: data.scope } : {}) } };
}
export function refreshToken(auth: Auth): string { if (!auth.refreshToken) throw new AppError('AUTH_EXPIRED', 'No refresh credential is available. Sign in again.', 401); return auth.refreshToken; }
