import { AppError, type Account, type Provider } from '../types.js';
import { Store } from '../store/index.js';
import { Notifier } from '../notify/index.js';
import { getProvider } from '../providers/index.js';

export class Scheduler {
  private inFlight = new Map<string,Promise<void>>();
  private failures = new Map<string,number>();
  private timer: NodeJS.Timeout|undefined;
  private stopped = false;
  constructor(private store: Store, private notifier: Notifier, private providerFor: (id: Account['provider']) => Provider = getProvider, private random: () => number = Math.random) {}
  start(): void { this.stopped = false; for (const account of this.store.accounts()) if (account.auth && account.errorCode !== 'AUTH_EXPIRED') this.store.setNext(account.id,Date.now() + this.random()*10_000); this.timer = setInterval(() => this.tick(),1_000); this.timer.unref(); }
  private tick(): void { const now = Date.now(); for (const account of this.store.accounts()) if (account.auth && account.errorCode !== 'AUTH_EXPIRED' && (account.nextCheckAt ?? 0) <= now && !this.inFlight.has(account.id)) void this.check(account.id).catch(() => {}); }
  check(id: string): Promise<void> {
    if (this.stopped) return Promise.reject(new AppError('service_stopping','Service is shutting down',503));
    const existing = this.inFlight.get(id); if (existing) return existing;
    const work = this.run(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id,work); return work;
  }
  private async run(id: string): Promise<void> {
    const account = this.store.get(id);
    if (!account.auth) throw new AppError('not_authenticated','Sign in to this account first',409);
    const provider = this.providerFor(account.provider);
    let delay = account.interval * 1_000;
    let expectedAccessToken = account.auth.accessToken;
    let expectedRefreshToken = account.auth.refreshToken;
    let backingOff = false;
    let retryAfterMs = 0;
    try {
      let auth = account.auth;
      if (auth.expiresAt <= Date.now()+300_000) {
        try { auth = await provider.refresh(auth); } catch (error) {
          // Temporary outages must not destroy a rotating refresh token or require login.
          if (error instanceof AppError && (error.status === 429 || error.status >= 500 || error.code === 'UPSTREAM_TIMEOUT')) throw error;
          throw new AppError('AUTH_EXPIRED','Sign in again to renew this account',401);
        }
        if (this.stopped) return;
        const latest = this.store.get(id).auth;
        if (latest?.accessToken !== expectedAccessToken || latest?.refreshToken !== expectedRefreshToken) { delay = 0; return; }
        this.store.setAuth(id,auth);
        expectedAccessToken = auth.accessToken;
        expectedRefreshToken = auth.refreshToken;
      }
      const result = await provider.check(auth);
      if (this.stopped) return;
      // A newer login must supersede all results from the old grant.
      const latest = this.store.get(id).auth;
      if (latest?.accessToken !== expectedAccessToken || latest?.refreshToken !== expectedRefreshToken) { delay = 0; return; }
      this.store.saveQuota(id,result,Date.now());
      this.failures.delete(id);
      await this.notifier.quota(this.store.get(id),account.windows);
    } catch (error) {
      if (this.stopped) return;
      let current: Account;
      try { current = this.store.get(id); } catch { return; }
      if (current.auth?.accessToken !== expectedAccessToken || current.auth?.refreshToken !== expectedRefreshToken) { delay = 0; return; }
      const safe = error instanceof AppError ? error : new AppError('UPSTREAM_ERROR','Provider request failed',502);
      if (safe.status === 401 || safe.code === 'AUTH_EXPIRED') { this.store.setError(id,'AUTH_EXPIRED','Sign in again to renew this account'); await this.notifier.authExpired(current); delay = 30*60_000; }
      else {
        this.store.setError(id,safe.code,safe.message);
        if (safe.status === 429 || safe.status >= 500) {
          backingOff = true;
          retryAfterMs = Math.min(1_800_000,(safe.retryAfter ?? 0)*1_000);
          const count = (this.failures.get(id) ?? 0)+1;
          this.failures.set(id,count);
          delay = Math.min(1_800_000,Math.max(account.interval*1_000*2**Math.min(count-1,10),retryAfterMs));
        }
      }
      throw safe;
    } finally {
      if (!this.stopped) {
        try {
          this.store.get(id);
          const jittered = Math.round(delay*(0.9+this.random()*0.2));
          this.store.setNext(id,Date.now()+(backingOff ? Math.min(1_800_000,Math.max(retryAfterMs,jittered)) : jittered));
        } catch { /* Account removed during the check. */ }
      }
    }
  }
  reschedule(id: string): void { const account = this.store.get(id); this.store.setNext(id,Date.now()+account.interval*1_000); }
  async stop(): Promise<void> { this.stopped = true; clearInterval(this.timer); await Promise.allSettled(this.inFlight.values()); }
}
