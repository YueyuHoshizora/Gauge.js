import type { Auth, Provider, QuotaResult } from '../types.js';
import { expect, form, iso, number, object, refreshToken, request, schema, text, tokens, window } from './common.js';
export const GROK_CLIENT = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
interface GrokBillingWindow { usedPercent: number; periodEnd: string | null; source: 'creditUsagePercent' | 'onDemandUsed/onDemandCap' }
export function parseGrokUsage(value: unknown): QuotaResult {
  const data = object(value); const sources = [data, object(data.config)];
  let used: number | undefined; let reset: unknown; let approximate = false;
  for (const source of sources) { used = number(source.creditUsagePercent); if (used !== undefined) break; }
  if (used === undefined) {
    for (const source of sources) {
      const consumption = number(object(source.onDemandUsed).val); const cap = number(object(source.onDemandCap).val);
      if (consumption !== undefined && consumption >= 0 && cap !== undefined && cap > 0) { used = consumption / cap * 100; approximate = true; break; }
    }
  }
  for (const source of sources) { reset = object(source.currentPeriod).end ?? source.billingPeriodEnd; if (reset !== undefined) break; }
  if (used === undefined) schema();
  const parsed: GrokBillingWindow = { usedPercent: used, periodEnd: iso(reset), source: approximate ? 'onDemandUsed/onDemandCap' : 'creditUsagePercent' };
  // On-demand is a different billing pool; do not label this fallback as confirmed subscription usage.
  return { windows: [window(approximate ? 'on_demand' : 'weekly', approximate ? 'On-demand credits' : 'Weekly credits', parsed.usedPercent, parsed.periodEnd, false, approximate)], meta: { quotaSource: parsed.source } };
}
export const grok: Provider = {
  async check(auth: Auth) {
    const headers = { Authorization: `Bearer ${auth.accessToken}`, 'x-xai-token-auth': 'xai-grok-cli', Accept: 'application/json' };
    const result = parseGrokUsage(expect(await request('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers })));
    try { const settings = expect(await request('https://cli-chat-proxy.grok.com/v1/settings', { headers })); const plan = text(settings.subscription_tier_display) ?? text(object(settings.config).subscription_tier_display); if (plan) result.meta.plan = plan; } catch { /* Optional profile lookup must not discard authoritative quota. */ }
    const email = text(auth.extra.email); if (email) result.meta.email = email;
    return result;
  },
  async refresh(auth: Auth) { return tokens(expect(await request('https://auth.x.ai/oauth2/token', form({ grant_type: 'refresh_token', refresh_token: refreshToken(auth), client_id: GROK_CLIENT })), true), auth); },
};
