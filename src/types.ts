export const PROVIDERS = ['antigravity', 'codex', 'claude', 'grok'] as const;
export type ProviderId = typeof PROVIDERS[number];
export const INTERVALS = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000] as const;
export type Locale = 'zh-TW' | 'en' | 'ja';
export interface QuotaWindow { key: string; label: string; usedPct: number; remainingPct: number; resetsAt: string | null; approximate?: boolean }
export interface QuotaResult { windows: QuotaWindow[]; meta: { plan?: string; email?: string; credits?: number; [key: string]: unknown }; raw?: unknown }
export interface Auth { type: string; accessToken: string; refreshToken?: string; expiresAt: number; extra: Record<string, unknown> }
export interface Account { id: string; provider: ProviderId; label: string; interval: number; thresholds: { lowPct: number; recoverPct: number }; auth: Auth | null; windows: QuotaWindow[]; meta: QuotaResult['meta']; fetchedAt: number | null; error: string | null; errorCode: string | null; nextCheckAt: number | null }
export interface Sample { t: number; remainingPct: number }
export type PublicAccount = Omit<Account, 'auth'> & { authenticated: boolean; samples: Sample[] };
export interface Settings { defaultInterval: number; defaultLocale: Locale; defaultTheme: string; cooldownHours: number; advancedIntervals: boolean; push: boolean }
export interface PushSubscriptionData { endpoint: string; keys: { p256dh: string; auth: string } }
export interface NotificationPayload { title: string; body: string; tag?: string; url?: string }
export interface LoginView { id: string; accountId: string; provider: ProviderId; status: 'pending' | 'complete' | 'error'; mode: 'device' | 'paste' | 'callback'; authorizationUrl?: string; verificationUri?: string; userCode?: string; expiresAt: number; error?: string }
export interface LoginContext { cloud: boolean; port: number; onAuth: (accountId: string, auth: Auth) => void | Promise<void> }
export interface Provider { check(auth: Auth): Promise<QuotaResult>; refresh(auth: Auth): Promise<Auth> }
export class AppError extends Error { constructor(public code: string, message: string, public status = 400, public retryAfter?: number) { super(message); this.name = 'AppError'; } }
