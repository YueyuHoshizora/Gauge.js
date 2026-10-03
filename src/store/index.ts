import { DatabaseSync } from 'node:sqlite';
import * as sqlite from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, INTERVALS, PROVIDERS, type Account, type Auth, type PublicAccount, type ProviderId, type QuotaResult, type Settings, type PushSubscriptionData } from '../types.js';

type Row = Record<string, unknown>;
export interface EventRecord { id: string; accountId: string; kind: string; title: string; body: string; at: number; dedupeKey: string }
export const DEFAULT_SETTINGS: Settings = { defaultInterval: 300, defaultLocale: 'zh-TW', defaultTheme: 'system', cooldownHours: 6, advancedIntervals: false, push: true };
const themes = ['system', 'pure', 'snow', 'ivory', 'haze', 'silver', 'moonstone', 'graphite', 'steel', 'ink', 'void'];
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AppError('invalid_input', 'Expected a JSON object'); return value as Record<string, unknown>; }
export function validateSettings(input: unknown, previous: Settings): Settings {
  const body = object(input);
  for (const key of Object.keys(body)) if (!(key in DEFAULT_SETTINGS)) throw new AppError('invalid_setting', 'Unknown setting');
  const next = { ...previous, ...body } as Settings;
  if (!(INTERVALS as readonly number[]).includes(next.defaultInterval) || !['en', 'zh-TW', 'ja'].includes(next.defaultLocale) || !themes.includes(next.defaultTheme) || !Number.isFinite(next.cooldownHours) || next.cooldownHours < 0 || next.cooldownHours > 168 || typeof next.advancedIntervals !== 'boolean' || typeof next.push !== 'boolean') throw new AppError('invalid_setting', 'Invalid settings');
  return next;
}
export class Store {
  readonly db: DatabaseSync;
  readonly directory: string;
  readonly filename: string;
  constructor(directory = 'data') {
    this.directory = resolve(directory); mkdirSync(this.directory, { recursive: true, mode: 0o700 }); chmodSync(this.directory, 0o700);
    this.filename = join(this.directory, 'gauge.db');
    this.db = new DatabaseSync(this.filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);`);
    const version = this.db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version;
    if (!version) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE accounts(id TEXT PRIMARY KEY, provider TEXT NOT NULL, label TEXT NOT NULL, interval_sec INTEGER NOT NULL, thresholds_json TEXT NOT NULL, auth_json TEXT, last_windows_json TEXT NOT NULL DEFAULT '[]', last_meta_json TEXT NOT NULL DEFAULT '{}', fetched_at INTEGER, error TEXT, error_code TEXT, next_check_at INTEGER);
        CREATE TABLE samples(account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, t INTEGER NOT NULL, remaining_pct REAL NOT NULL);
        CREATE INDEX sample_account_time ON samples(account_id,t);
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE subscriptions(endpoint TEXT PRIMARY KEY,p256dh TEXT NOT NULL,auth TEXT NOT NULL,created_at INTEGER NOT NULL,user_agent TEXT NOT NULL);
        CREATE TABLE events(id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,kind TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,at INTEGER NOT NULL,dedupe_key TEXT NOT NULL);
        CREATE INDEX event_dedupe ON events(dedupe_key,at);
        CREATE TABLE window_states(account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,key TEXT NOT NULL,low INTEGER NOT NULL,PRIMARY KEY(account_id,key));
      `);
      this.db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(1, Date.now());
    });
    this.protect();
  }
  protect(): void { for (const suffix of ['', '-wal', '-shm']) { const file = this.filename + suffix; if (existsSync(file)) chmodSync(file, 0o600); } }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  private account(row: Row): Account { return { id: String(row.id), provider: row.provider as ProviderId, label: String(row.label), interval: Number(row.interval_sec), thresholds: JSON.parse(String(row.thresholds_json)) as Account['thresholds'], auth: row.auth_json ? JSON.parse(String(row.auth_json)) as Auth : null, windows: JSON.parse(String(row.last_windows_json)) as Account['windows'], meta: JSON.parse(String(row.last_meta_json)) as Account['meta'], fetchedAt: row.fetched_at === null ? null : Number(row.fetched_at), error: row.error === null ? null : String(row.error), errorCode: row.error_code === null ? null : String(row.error_code), nextCheckAt: row.next_check_at === null ? null : Number(row.next_check_at) }; }
  accounts(): Account[] { return this.db.prepare('SELECT * FROM accounts ORDER BY rowid').all().map(row => this.account(row)); }
  get(id: string): Account { const row = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(id); if (!row) throw new AppError('account_not_found', 'Account not found', 404); return this.account(row); }
  public(account: Account): PublicAccount { const {auth, ...safe} = account; return { ...safe, authenticated: !!auth, samples: this.db.prepare('SELECT t,remaining_pct FROM samples WHERE account_id=? ORDER BY t,rowid').all(account.id).map(row => ({ t: Number(row.t), remainingPct: Number(row.remaining_pct) })) }; }
  create(input: unknown): PublicAccount {
    const body = object(input); if (!(PROVIDERS as readonly unknown[]).includes(body.provider)) throw new AppError('invalid_provider', 'Unknown provider');
    const provider = body.provider as ProviderId;
    const defaults = this.settings();
    const interval = body.interval ?? (defaults.defaultInterval !== 300 ? defaults.defaultInterval : provider === 'grok' ? 600 : 300);
    const account: Account = { id: randomUUID(), provider, label: provider, interval: Number(interval), thresholds: { lowPct: 20, recoverPct: 90 }, auth: null, windows: [], meta: {}, fetchedAt: null, error: null, errorCode: null, nextCheckAt: null };
    const validated = this.validateAccount(body, account);
    this.db.prepare('INSERT INTO accounts(id,provider,label,interval_sec,thresholds_json) VALUES(?,?,?,?,?)').run(account.id, provider, validated.label, validated.interval, JSON.stringify(validated.thresholds));
    return this.public(this.get(account.id));
  }
  private validateAccount(body: Record<string, unknown>, previous: Account): Account {
    const allowed = ['provider', 'label', 'interval', 'thresholds'];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError('invalid_input', 'Unknown account field');
    if (body.provider !== undefined && body.provider !== previous.provider) throw new AppError('invalid_provider', 'Provider cannot be changed');
    const label = body.label === undefined ? previous.label : body.label;
    const interval = body.interval === undefined ? previous.interval : body.interval;
    const thresholds = body.thresholds === undefined ? previous.thresholds : object(body.thresholds);
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 100 || typeof interval !== 'number' || !(INTERVALS as readonly number[]).includes(interval)) throw new AppError('invalid_input', 'Invalid label or monitoring interval');
    if (previous.provider === 'claude' && interval < 300 && !this.settings().advancedIntervals) throw new AppError('claude_interval', 'Enable advanced intervals before using Claude intervals shorter than five minutes');
    const {lowPct, recoverPct} = thresholds;
    if (typeof lowPct !== 'number' || typeof recoverPct !== 'number' || !Number.isFinite(lowPct) || !Number.isFinite(recoverPct) || lowPct < 0 || lowPct > 100 || recoverPct < 0 || recoverPct > 100 || recoverPct <= lowPct) throw new AppError('invalid_thresholds', 'Recovery threshold must exceed low threshold (0–100)');
    return {...previous, label: label.trim(), interval, thresholds: {lowPct, recoverPct}};
  }
  update(id: string, input: unknown): PublicAccount { const account = this.validateAccount(object(input), this.get(id)); this.db.prepare('UPDATE accounts SET label=?,interval_sec=?,thresholds_json=? WHERE id=?').run(account.label, account.interval, JSON.stringify(account.thresholds), id); return this.public(this.get(id)); }
  delete(id: string): void { this.get(id); this.db.prepare('DELETE FROM accounts WHERE id=?').run(id); }
  setAuth(id: string, auth: Auth): void { this.get(id); this.db.prepare('UPDATE accounts SET auth_json=?,error=NULL,error_code=NULL,next_check_at=? WHERE id=?').run(JSON.stringify(auth), Date.now(), id); this.protect(); }
  saveQuota(id: string, result: QuotaResult, now: number): void { this.transaction(() => { this.db.prepare('UPDATE accounts SET last_windows_json=?,last_meta_json=?,fetched_at=?,error=NULL,error_code=NULL WHERE id=?').run(JSON.stringify(result.windows), JSON.stringify(result.meta), now, id); if (result.windows.length) { this.db.prepare('INSERT INTO samples VALUES(?,?,?)').run(id, now, Math.min(...result.windows.map(window => window.remainingPct))); this.db.prepare('DELETE FROM samples WHERE account_id=? AND rowid NOT IN (SELECT rowid FROM samples WHERE account_id=? ORDER BY t DESC,rowid DESC LIMIT 200)').run(id, id); } }); }
  setError(id: string, code: string, message: string): void { this.db.prepare('UPDATE accounts SET error=?,error_code=? WHERE id=?').run(message, code, id); }
  setNext(id: string, time: number): void { this.db.prepare('UPDATE accounts SET next_check_at=? WHERE id=?').run(time, id); }
  setting<T>(key: string, fallback: T): T { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(String(row.value)) as T : fallback; }
  putSetting(key: string, value: unknown): void { this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): Settings { return this.setting('preferences', DEFAULT_SETTINGS); }
  updateSettings(input: unknown): Settings { const settings = validateSettings(input, this.settings()); this.putSetting('preferences', settings); return settings; }
  subscriptions(): PushSubscriptionData[] { return this.db.prepare('SELECT endpoint,p256dh,auth FROM subscriptions').all().map(row => ({endpoint: String(row.endpoint), keys: {p256dh: String(row.p256dh), auth: String(row.auth)}})); }
  subscribe(subscription: PushSubscriptionData, agent: string): void { this.db.prepare('INSERT INTO subscriptions VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,user_agent=excluded.user_agent').run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, Date.now(), agent.slice(0, 500)); }
  unsubscribe(endpoint: string): void { this.db.prepare('DELETE FROM subscriptions WHERE endpoint=?').run(endpoint); }
  lowState(id: string, key: string): boolean | null { const row = this.db.prepare('SELECT low FROM window_states WHERE account_id=? AND key=?').get(id,key); return row ? Boolean(row.low) : null; }
  setLowState(id: string,key: string,low: boolean): void { this.db.prepare('INSERT INTO window_states VALUES(?,?,?) ON CONFLICT(account_id,key) DO UPDATE SET low=excluded.low').run(id,key,low ? 1 : 0); }
  event(event: Omit<EventRecord,'id'>, cooldownMs: number): EventRecord | null {
    const last = this.db.prepare('SELECT at FROM events WHERE dedupe_key=? ORDER BY at DESC LIMIT 1').get(event.dedupeKey);
    if (last && event.at - Number(last.at) < cooldownMs) return null;
    const saved = {...event,id: randomUUID()};
    this.db.prepare('INSERT INTO events(id,account_id,kind,title,body,at,dedupe_key) VALUES(?,?,?,?,?,?,?)').run(saved.id,saved.accountId,saved.kind,saved.title,saved.body,saved.at,saved.dedupeKey);
    return saved;
  }
  events(): EventRecord[] { return this.db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT 100').all().map(row => ({ id: String(row.id), accountId: String(row.account_id), kind: String(row.kind), title: String(row.title), body: String(row.body), at: Number(row.at), dedupeKey: String(row.dedupe_key) })); }
  async backup(destination: string): Promise<void> {
    const target = resolve(destination);
    if (target === this.filename || existsSync(target)) throw new AppError('backup_exists', 'Backup destination must be a new file');
    // Create exclusively with restricted permissions before SQLite writes sensitive data.
    closeSync(openSync(target,'wx',0o600));
    if ('backup' in sqlite && typeof sqlite.backup === 'function') await sqlite.backup(this.db,target);
    else this.db.prepare('VACUUM INTO ?').run(target);
    chmodSync(target,0o600);
  }
  close(): void { this.protect(); this.db.close(); }
}
