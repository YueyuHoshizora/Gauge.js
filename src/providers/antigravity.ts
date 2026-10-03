import { AppError } from '../types.js';
import type { Auth, Provider, QuotaResult, QuotaWindow } from '../types.js';
import { expect, form, iso, json, number, object, refreshToken, request, schema, text, tokens, window } from './common.js';
// Google's published installed-app credentials, not application-private secrets.
export const GOOGLE_CLIENT = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
export const GOOGLE_CLIENT_SECRET = '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';
interface GoogleQuotaBucket { modelId: string; tokenType: 'REQUESTS'; remainingFraction: number; resetTime: string | null; bucketId: string }
export function parseAntigravityUsage(value: unknown): QuotaResult {
  const data = object(value); const windows: QuotaWindow[] = [];
  if (!Array.isArray(data.buckets)) schema();
  for (const [index, value] of data.buckets.entries()) {
    const bucket = object(value); if (bucket.tokenType !== 'REQUESTS') continue;
    const model = text(bucket.modelId); const fraction = number(bucket.remainingFraction);
    if (!model || fraction === undefined || fraction < 0 || fraction > 1) schema();
    const parsed: GoogleQuotaBucket = { modelId: model, tokenType: 'REQUESTS', remainingFraction: fraction, resetTime: iso(bucket.resetTime), bucketId: text(bucket.bucketId) ?? String(index) };
    windows.push(window(`${parsed.modelId}.${parsed.bucketId}`, parsed.modelId, (1 - parsed.remainingFraction) * 100, parsed.resetTime));
  }
  if (!windows.length) schema();
  return { windows, meta: { quotaSource: 'retrieveUserQuota REQUESTS' } };
}
export function parseAntigravityModels(value: unknown): QuotaWindow[] {
  const windows: QuotaWindow[] = []; const models = object(object(value).models);
  for (const [id, value] of Object.entries(models)) {
    if (!/claude|gpt|openai/i.test(id)) continue;
    const model = object(value); const quota = object(model.quotaInfo); const fraction = number(quota.remainingFraction);
    if (fraction === undefined || fraction < 0 || fraction > 1) continue;
    windows.push(window(`vertex.${id}`, text(model.displayName) ?? id, (1 - fraction) * 100, quota.resetTime, false, true));
  }
  return windows;
}
export const antigravity: Provider = {
  async check(auth: Auth) {
    const metadata = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
    let project: string | undefined;
    let profile: Record<string, unknown> = {};
    try {
      profile = expect(await request('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', json({ metadata }, auth.accessToken)));
      project = text(profile.cloudaicompanionProject) ?? text(object(profile.cloudaicompanionProject).id);
    } catch { /* Quota can still be available when supplementary profile lookup fails. */ }
    const response = await request('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', json(project ? { project } : {}, auth.accessToken));
    const subscriptionRequired = response.status === 403 && Array.isArray(object(response.data.error).details) && (object(response.data.error).details as unknown[]).some(value => {
      const detail = object(value);
      return detail.domain === 'cloudaicompanion.googleapis.com' && detail.reason === 'SUBSCRIPTION_REQUIRED';
    });
    if (subscriptionRequired) {
      const unsupported = Array.isArray(profile.ineligibleTiers) && profile.ineligibleTiers.some(value => object(value).reasonCode === 'UNSUPPORTED_CLIENT');
      const licensed = text(object(profile.paidTier).id) || text(object(profile.paidTier).name) || ['standard-tier', 'enterprise-tier'].includes(text(object(profile.currentTier).id) ?? '');
      if (unsupported && !licensed) throw new AppError('GOOGLE_CONSUMER_UNSUPPORTED', 'Google no longer supports consumer accounts through this Gemini CLI OAuth client. Use Antigravity or a supported Code Assist subscription.', 400);
      throw new AppError('GOOGLE_SUBSCRIPTION_REQUIRED', 'Google requires a supported Code Assist subscription and project for this quota endpoint.', 400);
    }
    const result = parseAntigravityUsage(expect(response));
    const tier = object(profile.paidTier ?? profile.currentTier); const plan = text(tier.name) ?? text(tier.id);
    if (plan) result.meta.plan = plan;
    if (project) result.meta.project = project;
    const email = text(profile.email) ?? text(auth.extra.email); if (email) result.meta.email = email;
    try {
      const init = json(project ? { project } : {}, auth.accessToken);
      init.headers = { ...init.headers, 'Client-Metadata': JSON.stringify(metadata) };
      const models = expect(await request('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', init));
      result.windows.push(...parseAntigravityModels(models));
      result.meta.approximatePool = 'ANTHROPIC and OPENAI models share the Vertex provider pool';
    } catch { /* Model-pool estimates must not replace the authoritative REQUESTS buckets. */ }
    return result;
  },
  async refresh(auth: Auth) { return tokens(expect(await request('https://oauth2.googleapis.com/token', form({ grant_type: 'refresh_token', refresh_token: refreshToken(auth), client_id: GOOGLE_CLIENT, client_secret: GOOGLE_CLIENT_SECRET })), true), auth); },
};
