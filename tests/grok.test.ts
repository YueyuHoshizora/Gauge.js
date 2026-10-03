import test from 'node:test';
import assert from 'node:assert/strict';
import { grok, parseGrokUsage } from '../src/providers/grok.js';
import { AppError, type Auth } from '../src/types.js';

const period = { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-01T00:00:00Z', end: '2026-10-08T00:00:00Z' };
const periodOnlyBilling = { config: { currentPeriod: period, onDemandUsed: { val: 0 }, onDemandCap: { val: 0 }, isUnifiedBillingUser: true, prepaidBalance: { val: 0 }, billingPeriodEnd: period.end } };

test('Grok authenticated period-only billing reports unavailable quota, not bad credentials or invented zero', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(periodOnlyBilling));
  const auth: Auth = { type: 'oauth', accessToken: 'test-access', expiresAt: Date.now() + 3_600_000, extra: {} };
  await assert.rejects(grok.check(auth), error => error instanceof AppError && error.code === 'GROK_QUOTA_UNAVAILABLE' && error.status === 400);
});

test('Grok period-only classification preserves actual usage and malformed-schema failures', () => {
  for (const value of [periodOnlyBilling, { currentPeriod: period }, { config: { currentPeriod: { ...period, type: 'USAGE_PERIOD_TYPE_MONTHLY' } } }]) {
    assert.throws(() => parseGrokUsage(value), { code: 'GROK_QUOTA_UNAVAILABLE' });
  }
  const unused = parseGrokUsage({ config: { ...periodOnlyBilling.config, creditUsagePercent: 0 } });
  assert.equal(unused.windows[0]?.remainingPct, 100);
  assert.equal(unused.windows[0]?.approximate, undefined);
  const demand = parseGrokUsage({ config: { ...periodOnlyBilling.config, onDemandUsed: { val: 25 }, onDemandCap: { val: 100 } } });
  assert.equal(demand.windows[0]?.remainingPct, 75);
  assert.equal(demand.windows[0]?.approximate, true);
  assert.equal(demand.windows[0]?.key, 'on_demand');
  for (const value of [{}, { config: { currentPeriod: { type: period.type } } }, { config: { ...periodOnlyBilling.config, creditUsagePercent: '' } }, { config: { currentPeriod: { ...period, end: 'invalid' } } }]) {
    assert.throws(() => parseGrokUsage(value), { code: 'UPSTREAM_SCHEMA' });
  }
});
