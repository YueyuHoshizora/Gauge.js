import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravity } from '../src/providers/antigravity.js';
import { AppError, type Auth } from '../src/types.js';

const auth: Auth = { type: 'oauth', accessToken: 'test-access', refreshToken: 'test-refresh', expiresAt: Date.now() + 3_600_000, extra: {} };
const subscriptionError = { error: { status: 'PERMISSION_DENIED', message: 'private-upstream-details', details: [{ domain: 'cloudaicompanion.googleapis.com', reason: 'SUBSCRIPTION_REQUIRED' }] } };
const unsupportedProfile = { ineligibleTiers: [{ tierId: 'free-tier', reasonCode: 'UNSUPPORTED_CLIENT' }] };

test('Google consumer shutdown is distinguished from failed OAuth without exposing upstream details', async t => {
  t.mock.method(globalThis, 'fetch', async (url: URL) => url.pathname.endsWith(':loadCodeAssist')
    ? Response.json(unsupportedProfile)
    : Response.json(subscriptionError, { status: 403 }));
  await assert.rejects(antigravity.check(auth), error => error instanceof AppError && error.code === 'GOOGLE_CONSUMER_UNSUPPORTED' && !error.message.includes('private-upstream-details'));
});

test('Google licensed accounts and unrelated permission failures are not misclassified as consumer shutdown', async t => {
  let profile: Record<string, unknown> = { ...unsupportedProfile, currentTier: { id: 'standard-tier' } };
  let errorBody: Record<string, unknown> = subscriptionError;
  t.mock.method(globalThis, 'fetch', async (url: URL) => url.pathname.endsWith(':loadCodeAssist')
    ? Response.json(profile)
    : Response.json(errorBody, { status: 403 }));
  await assert.rejects(antigravity.check(auth), { code: 'GOOGLE_SUBSCRIPTION_REQUIRED' });
  profile = { ...unsupportedProfile, paidTier: { name: 'Code Assist Enterprise' } };
  await assert.rejects(antigravity.check(auth), { code: 'GOOGLE_SUBSCRIPTION_REQUIRED' });
  profile = unsupportedProfile; errorBody = { error: { details: [{ domain: 'cloudaicompanion.googleapis.com', reason: 'OTHER_PERMISSION' }] } };
  await assert.rejects(antigravity.check(auth), { code: 'UPSTREAM_ERROR' });
});

test('Google discovers the quota project before querying and preserves genuine zero usage', async t => {
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (url.pathname.endsWith(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: { id: 'test-project' }, currentTier: { id: 'standard-tier' } });
    if (url.pathname.endsWith(':retrieveUserQuota')) {
      if (JSON.parse(String(init.body)).project !== 'test-project') return Response.json(subscriptionError, { status: 403 });
      return Response.json({ buckets: [{ modelId: 'gemini-pro', tokenType: 'REQUESTS', remainingFraction: 1 }] });
    }
    return Response.json({ models: {} });
  });
  const result = await antigravity.check(auth);
  assert.equal(result.windows[0]?.remainingPct, 100);
  assert.equal(result.meta.project, 'test-project');
});

test('Google quota remains usable when optional profile discovery fails', async t => {
  t.mock.method(globalThis, 'fetch', async (url: URL) => url.pathname.endsWith(':retrieveUserQuota')
    ? Response.json({ buckets: [{ modelId: 'gemini-pro', tokenType: 'REQUESTS', remainingFraction: 0.2 }] })
    : Response.json({}, { status: 503 }));
  assert.equal((await antigravity.check(auth)).windows[0]?.remainingPct, 20);
});
