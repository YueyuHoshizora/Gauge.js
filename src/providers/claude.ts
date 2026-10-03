import type { Auth, Provider, QuotaResult } from '../types.js';
import { expect, iso, json, number, object, refreshToken, request, schema, text, tokens, window, type ObjectValue } from './common.js';
export const CLAUDE_CLIENT = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
interface ClaudeUsageWindow { utilization: number; resets_at: string | null }
export function parseClaudeUsage(value: unknown): QuotaResult {
  const data = object(value); const windows = [];
  const labels: Record<string, string> = { five_hour: '5 hours', seven_day: '7 days', seven_day_sonnet: 'Sonnet · 7 days', seven_day_opus: 'Opus · 7 days', seven_day_oauth_apps: 'OAuth apps · 7 days' };
  for (const [key, label] of Object.entries(labels)) {
    const bucket = object(data[key]); if (!Object.keys(bucket).length) continue;
    const used = number(bucket.utilization); if (used === undefined) schema();
    const parsed: ClaudeUsageWindow = { utilization: used, resets_at: iso(bucket.resets_at) };
    windows.push(window(key, label, parsed.utilization, parsed.resets_at));
  }
  if (!windows.length) schema();
  return { windows, meta: {} };
}
export async function claudeToken(body: ObjectValue, signal?: AbortSignal): Promise<ObjectValue> {
  let response = await request('https://console.anthropic.com/v1/oauth/token', json(body), signal);
  // Only retry a missing route: repeating a token exchange after an ambiguous failure can consume a rotating token twice.
  if ([404, 405].includes(response.status)) response = await request('https://platform.claude.com/v1/oauth/token', json(body), signal);
  return expect(response, true);
}
export const claude: Provider = {
  async check(auth: Auth) {
    const data = expect(await request('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${auth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' } }));
    const result = parseClaudeUsage(data); const email = text(auth.extra.email); if (email) result.meta.email = email;
    return result;
  },
  async refresh(auth: Auth) { return tokens(await claudeToken({ grant_type: 'refresh_token', refresh_token: refreshToken(auth), client_id: CLAUDE_CLIENT }), auth); },
};
