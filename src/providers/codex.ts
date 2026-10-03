import type { Auth, Provider, QuotaResult } from '../types.js';
import { expect, form, iso, number, object, refreshToken, request, schema, text, tokens, window } from './common.js';
export const CODEX_CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
interface CodexRateWindow { used_percent: number; limit_window_seconds: number; reset_at: string | null }
export function parseCodexUsage(value: unknown): QuotaResult {
  const data = object(value); const windows = [];
  const groups = [{ key: '', label: '', rate: object(data.rate_limit) }];
  if (Array.isArray(data.additional_rate_limits)) {
    for (const [index, entry] of data.additional_rate_limits.entries()) { const item = object(entry); groups.push({ key: `${text(item.metered_feature) ?? index}.`, label: `${text(item.limit_name) ?? text(item.metered_feature) ?? 'Additional'} · `, rate: object(item.rate_limit) }); }
  }
  for (const group of groups) {
    for (const key of ['primary', 'secondary']) {
      const bucket = object(group.rate[`${key}_window`] ?? group.rate[key]); if (!Object.keys(bucket).length) continue;
      const minutes = number(bucket.window_minutes) ?? ((number(bucket.limit_window_seconds) ?? 0) / 60);
      const resetAfter = number(bucket.reset_after_seconds);
      const reset = bucket.reset_at ?? bucket.resets_at ?? (resetAfter !== undefined ? Date.now() / 1000 + resetAfter : undefined);
      const used = number(bucket.used_percent); if (used === undefined) schema();
      const parsed: CodexRateWindow = { used_percent: used, limit_window_seconds: minutes * 60, reset_at: iso(reset, true) };
      const label = parsed.limit_window_seconds > 0 ? `${parsed.limit_window_seconds / 60} minutes` : key;
      windows.push(window(`${group.key}${key}`, `${group.label}${label}`, parsed.used_percent, parsed.reset_at));
    }
  }
  if (!windows.length) schema();
  const meta: QuotaResult['meta'] = {};
  const credits = number(object(data.credits).balance); const plan = text(data.plan_type); const email = text(data.email);
  if (credits !== undefined) meta.credits = credits;
  if (plan) meta.plan = plan; if (email) meta.email = email;
  if (typeof object(data.rate_limit).limit_reached === 'boolean') meta.limitReached = object(data.rate_limit).limit_reached;
  return { windows, meta };
}
export const codex: Provider = {
  async check(auth: Auth) {
    const headers: Record<string, string> = { Authorization: `Bearer ${auth.accessToken}`, Accept: 'application/json' }; const accountId = text(auth.extra.accountId);
    if (accountId) headers['ChatGPT-Account-Id'] = accountId;
    const endpoints = ['https://chatgpt.com/backend-api/wham/usage', 'https://chatgpt.com/backend-api/codex/usage', 'https://chatgpt.com/api/codex/usage'];
    for (const [index, endpoint] of endpoints.entries()) {
      const response = await request(endpoint, { headers });
      if ([404, 405].includes(response.status) && index < endpoints.length - 1) continue;
      const result = parseCodexUsage(expect(response)); const email = text(auth.extra.email); if (!result.meta.email && email) result.meta.email = email;
      return result;
    }
    return schema();
  },
  async refresh(auth: Auth) { return tokens(expect(await request('https://auth.openai.com/oauth/token', form({ grant_type: 'refresh_token', refresh_token: refreshToken(auth), client_id: CODEX_CLIENT })), true), auth); },
};
