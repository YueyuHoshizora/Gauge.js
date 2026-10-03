import { initializeLocales, locale, setLocale, storageGet, storageSet, validLocale, t, hasTranslation, number, percent, date, time, duration, errorText } from './i18n.js';

type Provider = 'antigravity' | 'codex' | 'claude' | 'grok';
interface WindowQuota { key: string; label: string; remainingPct: number; usedPct: number; resetsAt: string | null; approximate?: boolean }
interface Account { id: string; provider: Provider; label: string; interval: number; thresholds: { lowPct: number; recoverPct: number }; windows: WindowQuota[]; meta: { plan?: string; email?: string; credits?: number }; fetchedAt: number | null; error: string | null; errorCode: string | null; nextCheckAt: number | null; authenticated: boolean; samples: { t: number; remainingPct: number }[] }
interface Settings { defaultInterval: number; defaultLocale: 'zh-TW' | 'en' | 'ja'; defaultTheme: string; cooldownHours: number; advancedIntervals: boolean; push: boolean }
interface Login { id: string; accountId: string; provider: Provider; status: 'pending' | 'complete' | 'error'; mode: 'device' | 'paste' | 'callback'; authorizationUrl?: string; verificationUri?: string; userCode?: string; expiresAt: number; error?: string }
interface NotificationEvent { id: string; accountId: string; kind: string; title: string; body: string; at: number; dedupeKey: string }
interface Status { accounts: Account[]; settings: Settings; serverTime: number; startedAt: number; cloud: boolean }
interface InstallPrompt extends Event { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> }
const intervals = [30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 18000];
const themes = ['pure', 'snow', 'ivory', 'haze', 'silver', 'moonstone', 'graphite', 'steel', 'ink', 'void'];
const defaults: Record<Provider, number> = { antigravity: 300, codex: 300, claude: 300, grok: 600 };
let accounts: Account[] = [];
let settings: Settings | null = null;
let events: NotificationEvent[] = [];
let eventsFetched = false;
let cloud = false;
let lastConnected = 0;
let serverOffset = 0;
let connectionFailed = false;
let statusLoading = false;
let editId: string | null = null;
let deleteId: string | null = null;
let loginAccount: Account | null = null;
let login: Login | null = null;
let loginTimer: number | undefined;
let loginGeneration = 0;
let pin = storageGet('gauge.pin', true) ?? '';
let themePreference = storageGet('gauge.theme') ?? 'system';
let installPrompt: InstallPrompt | null = null;
let registration: ServiceWorkerRegistration | null = null;
let activeTab = 'accounts';
let toastTimer: number | undefined;
let toastKey: string | null = null;
let toastValues: Record<string, string | number> = {};
let toastErrorCode: string | null = null;
let pinErrorCode: string | null = null;
let pendingTasks = 0;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}
function escape(value: string | number): string { return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!); }
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(form: HTMLFormElement, name: string): T {
  return form.elements.namedItem(name) as T;
}
function toast(key: string, values: Record<string, string | number> = {}): void {
  toastKey = key; toastValues = values;
  toastErrorCode = null;
  element('toast').textContent = t(key, values); element('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element('toast').hidden = true; toastKey = null; }, 6500);
}
function showError(error: unknown): void {
  toastErrorCode = error instanceof ApiError ? error.code : 'generic';
  element('toast').textContent = errorText(toastErrorCode);
  element('toast').hidden = false; toastKey = null;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element('toast').hidden = true; }, 8000);
}
class ApiError extends Error { constructor(public code: string) { super(code); } }
function requirePin(): void {
  pin = ''; storageSet('gauge.pin', null, true);
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) dialog.close();
  clearTimeout(loginTimer); loginGeneration++; login = null; loginAccount = null;
  accounts = []; events = []; eventsFetched = false; lastConnected = 0; settings = null; renderAccounts(); renderEvents(); renderSummary();
  element<HTMLDialogElement>('pin-dialog').showModal();
  element<HTMLInputElement>('pin').focus(); element('lock').hidden = true;
}
async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  const requestPin = pin;
  try {
    response = await fetch(path, { method, cache: 'no-store', credentials: 'same-origin', headers: { ...(pin ? { Authorization: `Bearer ${pin}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) });
  } catch { throw new ApiError('NETWORK'); }
  if (requestPin !== pin) throw new ApiError('AUTH_REQUIRED');
  const data: unknown = await response.json().catch(() => null);
  if (requestPin !== pin) throw new ApiError('AUTH_REQUIRED');
  if (!response.ok) {
    const code = data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object' && 'code' in data.error ? String(data.error.code) : 'generic';
    // Provider credentials and the dashboard PIN are independent trust boundaries.
    if (response.status === 401 && code.toUpperCase() === 'AUTH_REQUIRED') { requirePin(); throw new ApiError('AUTH_REQUIRED'); }
    throw new ApiError(code);
  }
  return data as T;
}
async function perform(control: HTMLButtonElement | HTMLFormElement, action: () => Promise<void>): Promise<void> {
  if (control.dataset.busy === 'true') return;
  if (control instanceof HTMLFormElement && !control.checkValidity()) { toast('validationError'); return; }
  control.dataset.busy = 'true'; pendingTasks++;
  const buttons = control instanceof HTMLButtonElement ? [control] : Array.from(control.querySelectorAll<HTMLButtonElement>('button[type=submit]'));
  for (const button of buttons) button.disabled = true;
  try { await action(); } catch (error) { showError(error); }
  finally {
    control.dataset.busy = 'false'; pendingTasks--;
    for (const button of buttons) button.disabled = false;
    if (control.id.startsWith('push-')) await updatePushStatus();
  }
}
function themeOptions(value: string): string {
  return ['system', ...themes].map(theme => `<option value="${theme}" ${theme === value ? 'selected' : ''}>${escape(t(theme === 'system' ? 'system' : `theme.${theme}`))}</option>`).join('');
}
function applyTheme(): void {
  if (!themes.includes(themePreference) && themePreference !== 'system') themePreference = 'system';
  const effective = themePreference === 'system' ? (systemTheme.matches ? 'ink' : 'pure') : themePreference;
  document.documentElement.dataset.theme = effective;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')!.content = color;
  // A per-device manifest preserves the server manifest while matching the selected theme.
  const home = `${location.origin}/`;
  const manifest = { id: home, name: 'Gauge.js', short_name: 'Gauge.js', description: t('eyebrow'), start_url: home, scope: home, display: 'standalone', background_color: color, theme_color: color, icons: [{ src: `${location.origin}/icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: `${location.origin}/icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: `${location.origin}/icons/maskable-192.png`, sizes: '192x192', type: 'image/png', purpose: 'maskable' }, { src: `${location.origin}/icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }] };
  const link = document.querySelector<HTMLLinkElement>('link[rel=manifest]')!;
  const oldUrl = link.href;
  link.href = URL.createObjectURL(new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' }));
  if (oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
}
function intervalOptions(selected: number, provider?: Provider): string {
  return intervals.filter(value => provider !== 'claude' || settings?.advancedIntervals || value >= 300 || value === selected).map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${escape(duration(value * 1000))}</option>`).join('');
}
function translateShell(): void {
  for (const item of document.querySelectorAll<HTMLElement>('[data-i18n]')) item.textContent = t(item.dataset.i18n!);
  for (const close of document.querySelectorAll<HTMLElement>('.icon-button')) close.setAttribute('aria-label', t('close'));
  element('summary').setAttribute('aria-label', t('summary'));
  document.querySelector('nav')!.setAttribute('aria-label', t('navigation'));
  element<HTMLSelectElement>('locale').value = locale;
  element('locale').setAttribute('aria-label', t('language')); element('theme').setAttribute('aria-label', t('theme'));
  element('theme').innerHTML = themeOptions(themePreference);
  if (toastKey) element('toast').textContent = t(toastKey, toastValues);
  if (toastErrorCode && !element('toast').hidden) element('toast').textContent = errorText(toastErrorCode);
  if (pinErrorCode) element('pin-error').textContent = errorText(pinErrorCode);
  element('account-title').textContent = t(editId ? 'editAccount' : 'addAccount');
  if (element<HTMLDialogElement>('account-dialog').open) updateAccountIntervals(false);
  if (deleteId) { const account = accounts.find(item => item.id === deleteId); if (account) element('delete-message').textContent = t('deleteConfirm', { name: account.label }); }
  if (loginAccount) { const selected = element<HTMLSelectElement>('login-mode').value; renderLoginModes(); element<HTMLSelectElement>('login-mode').value = selected; renderLogin(); }
  populateSettings(false); renderAccounts(); renderSummary(); renderEvents(); renderConnection(); applyTheme(); void updatePushStatus();
}
function renderSummary(): void {
  element('summary').innerHTML = [[accounts.length, 'totalAccounts'], [accounts.filter(account => account.authenticated).length, 'connectedAccounts'], [accounts.filter(account => account.windows.some(window => window.remainingPct <= account.thresholds.lowPct)).length, 'lowAccounts']].map(([value, key]) => `<div class="stat"><strong>${lastConnected ? number(Number(value)) : '—'}</strong><span>${escape(t(String(key)))}</span></div>`).join('');
}
function windowLabel(window: Pick<WindowQuota, 'key' | 'label'>): string {
  if (hasTranslation(`window.${window.key}`)) return t(`window.${window.key}`);
  if (window.key.startsWith('seven_day_')) return `${window.key.includes('sonnet') ? 'Sonnet' : window.key.includes('opus') ? 'Opus' : 'OAuth'} · ${t('window.seven_day')}`;
  if (window.key.endsWith('.primary') || window.key.endsWith('.secondary')) {
    const key = window.key.endsWith('.primary') ? 'primary' : 'secondary';
    return `${window.key.slice(0, -(key.length + 1))} · ${t(`window.${key}`)}`;
  }
  return window.label; // Provider model names are data, not UI copy.
}
function renderTrend(account: Account): string {
  const samples = account.samples.filter(sample => Number.isFinite(sample.t) && Number.isFinite(sample.remainingPct)).slice(-200);
  if (!samples.length) return `<p class="hint">${escape(t('trendEmpty'))}</p>`;
  const first = samples[0]!; const last = samples[samples.length - 1]!;
  const span = last.t - first.t;
  const points = samples.map((sample, index) => `${(span > 0 ? (sample.t - first.t) / span * 440 : index / Math.max(1, samples.length - 1) * 440).toFixed(2)},${(68 - Math.max(0, Math.min(100, sample.remainingPct)) * .6).toFixed(2)}`).join(' ');
  const label = t('trendLabel', { start: date(first.t), end: date(last.t), value: percent(last.remainingPct) });
  return `<svg class="trend" viewBox="0 0 440 76" role="img" aria-label="${escape(label)}" preserveAspectRatio="none"><path d="M0 68H440 M0 8H440" fill="none" stroke="var(--border)" stroke-width="1"/><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" vector-effect="non-scaling-stroke"/>${samples.length === 1 ? '<circle cx="0" cy="' + (68 - first.remainingPct * .6) + '" r="3" fill="currentColor"/>' : ''}</svg><div class="trend-caption"><span>${escape(t('trend', { count: number(samples.length) }))}</span><span>${escape(time(last.t))}</span></div>`;
}
function renderAccounts(): void {
  if (!lastConnected) { element('accounts').innerHTML = `<div class="skeleton">${escape(t(connectionFailed ? 'neverConnected' : 'loading'))}</div>`; return; }
  if (!accounts.length) {
    element('accounts').innerHTML = `<div class="empty"><h3>${escape(t('emptyTitle'))}</h3><p>${escape(t('emptyHelp'))}</p><button class="primary" data-action="add">${escape(t('addAccount'))}</button></div>`; return;
  }
  element('accounts').innerHTML = accounts.map(account => {
    const min = account.windows.length ? Math.min(...account.windows.map(window => window.remainingPct)) : null;
    const badge = !account.authenticated ? 'notAuthenticated' : account.error ? 'error' : min !== null && min <= 0 ? 'exhausted' : min !== null && min <= account.thresholds.lowPct ? 'low' : 'healthy';
    const color = badge === 'error' || badge === 'exhausted' ? 'bad' : badge === 'low' || badge === 'notAuthenticated' ? 'warn' : 'good';
    const meta = [account.meta.email, account.meta.plan, typeof account.meta.credits === 'number' ? t('credits', { value: number(account.meta.credits, 2) }) : ''].filter(Boolean).map(value => escape(value!)).join(' · ');
    return `<article class="account-card" data-account-id="${escape(account.id)}"><div class="card-heading"><div><p class="provider">${escape(account.provider)}</p><h3 class="account-name">${escape(account.label)}</h3></div><span class="badge ${color}">${escape(t(badge))}</span></div><p class="account-meta">${meta || escape(duration(account.interval * 1000))}</p>${account.error ? `<p class="account-error">${escape(errorText(account.errorCode))}</p>` : ''}${account.windows.length ? account.windows.map(window => {
      const level = window.remainingPct <= 0 ? 'bad' : window.remainingPct <= account.thresholds.lowPct ? 'warn' : 'good';
      return `<div class="quota"><div class="quota-heading"><span class="quota-label">${escape(windowLabel(window))}</span><strong>${escape(percent(window.remainingPct))}</strong></div><progress class="meter ${level}" max="100" value="${Math.max(0, Math.min(100, window.remainingPct))}" aria-label="${escape(windowLabel(window) + ' · ' + t('remaining'))}" aria-valuetext="${escape(percent(window.remainingPct))}"></progress><div class="quota-foot"><span data-reset="${escape(window.resetsAt ?? '')}"></span><span>${escape(t(window.approximate ? 'approximate' : 'authoritative'))}</span></div></div>`;
    }).join('') : `<p class="hint">${escape(t('noData'))}</p>`}<div class="freshness"><span data-fetched="${account.fetchedAt ?? ''}" data-interval="${account.interval}"></span><span data-next="${account.nextCheckAt ?? ''}" data-authenticated="${account.authenticated && account.errorCode !== 'AUTH_EXPIRED'}"></span></div>${renderTrend(account)}<div class="card-actions"><button data-action="check" ${!account.authenticated ? 'disabled' : ''}>${escape(t('checkNow'))}</button><button data-action="login">${escape(t(account.authenticated ? 'reconnect' : 'connect'))}</button><button data-action="edit">${escape(t('edit'))}</button><button data-action="delete" class="danger">${escape(t('delete'))}</button></div></article>`;
  }).join('');
  updateClocks();
}
function updateClocks(): void {
  const now = Date.now() + serverOffset;
  for (const item of document.querySelectorAll<HTMLElement>('[data-reset]')) {
    const reset = item.dataset.reset ? Date.parse(item.dataset.reset) : NaN;
    item.textContent = !Number.isFinite(reset) ? t('resetUnknown') : reset <= now ? t('resetPending') : t('resetIn', { duration: duration(reset - now) });
    item.title = Number.isFinite(reset) ? date(reset) : '';
  }
  for (const item of document.querySelectorAll<HTMLElement>('[data-fetched]')) {
    const fetched = Number(item.dataset.fetched);
    const stale = fetched > 0 && now - fetched > Math.max(Number(item.dataset.interval) * 2000, 120000);
    item.textContent = fetched ? `${t('lastFetched', { duration: duration(now - fetched) })}${stale ? ' · ' + t('staleData') : ''}` : t('neverFetched');
    item.title = fetched ? date(fetched) : '';
    item.classList.toggle('stale-data', stale);
  }
  for (const item of document.querySelectorAll<HTMLElement>('[data-next]')) {
    const next = Number(item.dataset.next);
    item.textContent = item.dataset.authenticated !== 'true' ? t('paused') : !next || next <= now ? t('checkDue') : t('nextCheck', { duration: duration(next - now) });
  }
  if (login?.status === 'pending') {
    const remaining = login.expiresAt - now;
    element('login-expiry').textContent = remaining > 0 ? t('loginExpires', { duration: duration(remaining) }) : t('loginExpired');
    if (remaining <= 0) { clearTimeout(loginTimer); element('login-state').textContent = t('loginExpired'); element<HTMLButtonElement>('login-complete-form').querySelector<HTMLButtonElement>('button')!.disabled = true; }
  }
  renderConnection();
}
function renderConnection(): void {
  const connection = element('connection');
  const stale = Boolean(lastConnected && Date.now() - lastConnected > 90000);
  connection.className = `connection ${!navigator.onLine ? 'offline' : connectionFailed || stale ? 'stale' : ''}`;
  const text = !navigator.onLine ? t('offline') : connectionFailed ? (lastConnected ? t('unreachable', { time: time(lastConnected) }) : t('neverConnected')) : stale ? t('staleConnection') : lastConnected ? t('online', { time: time(lastConnected) }) : t('loading');
  const markup = `<span class="status-dot"></span><span>${escape(text)}</span>`;
  if (connection.innerHTML !== markup) connection.innerHTML = markup;
}
async function refreshStatus(throwErrors = false): Promise<void> {
  if (statusLoading || element<HTMLDialogElement>('pin-dialog').open) return;
  statusLoading = true;
  try {
    const state = await api<Status>('/api/status');
    accounts = state.accounts; settings = state.settings; cloud = state.cloud;
    serverOffset = state.serverTime - Date.now(); lastConnected = Date.now(); connectionFailed = false;
    if (!storageGet('gauge.theme')) {
      const preferredTheme = themes.includes(settings.defaultTheme) ? settings.defaultTheme : 'system';
      if (themePreference !== preferredTheme) { themePreference = preferredTheme; element('theme').innerHTML = themeOptions(themePreference); applyTheme(); }
    }
    if (!storageGet('gauge.locale') && validLocale(settings.defaultLocale) && locale !== settings.defaultLocale) { setLocale(settings.defaultLocale); translateShell(); }
    element('lock').hidden = !pin;
    renderAccounts(); renderSummary(); renderConnection(); populateSettings(false);
  } catch (error) { connectionFailed = true; renderConnection(); if (!lastConnected) renderAccounts(); if (throwErrors) throw error; }
  finally { statusLoading = false; }
}
function populateSettings(reset: boolean): void {
  const form = element<HTMLFormElement>('settings-form');
  if (!settings) return;
  if (!reset && (form.dataset.dirty === 'true' || form.contains(document.activeElement))) {
    const themeField = field<HTMLSelectElement>(form, 'defaultTheme'); themeField.innerHTML = themeOptions(themeField.value);
    const intervalField = field<HTMLSelectElement>(form, 'defaultInterval'); intervalField.innerHTML = intervalOptions(Number(intervalField.value)); return;
  }
  field<HTMLSelectElement>(form, 'defaultInterval').innerHTML = intervalOptions(settings.defaultInterval);
  element('default-interval-warning').hidden = settings.defaultInterval >= 60;
  field<HTMLSelectElement>(form, 'defaultLocale').value = settings.defaultLocale;
  field<HTMLSelectElement>(form, 'defaultTheme').innerHTML = themeOptions(settings.defaultTheme);
  field<HTMLInputElement>(form, 'cooldownHours').value = String(settings.cooldownHours);
  field<HTMLInputElement>(form, 'advancedIntervals').checked = settings.advancedIntervals;
  field<HTMLInputElement>(form, 'push').checked = settings.push;
}
function openAccount(account?: Account): void {
  const form = element<HTMLFormElement>('account-form'); form.reset(); editId = account?.id ?? null;
  const provider = field<HTMLSelectElement>(form, 'provider'); provider.value = account?.provider ?? 'antigravity'; provider.disabled = Boolean(account);
  field<HTMLInputElement>(form, 'label').value = account?.label ?? '';
  field<HTMLInputElement>(form, 'lowPct').value = String(account?.thresholds.lowPct ?? 20);
  field<HTMLInputElement>(form, 'recoverPct').value = String(account?.thresholds.recoverPct ?? 90);
  const interval = account?.interval ?? (settings?.defaultInterval !== 300 ? settings?.defaultInterval : defaults[provider.value as Provider]) ?? 300;
  field<HTMLSelectElement>(form, 'interval').innerHTML = intervalOptions(interval, provider.value as Provider);
  updateAccountIntervals(false); element('account-title').textContent = t(account ? 'editAccount' : 'addAccount');
  element<HTMLDialogElement>('account-dialog').showModal(); field<HTMLInputElement>(form, 'label').focus();
}
function updateAccountIntervals(providerChanged: boolean): void {
  const form = element<HTMLFormElement>('account-form'); const provider = field<HTMLSelectElement>(form, 'provider').value as Provider;
  const interval = field<HTMLSelectElement>(form, 'interval');
  let selected = providerChanged ? (settings?.defaultInterval !== 300 ? settings?.defaultInterval : defaults[provider]) ?? defaults[provider] : Number(interval.value);
  if (provider === 'claude' && !settings?.advancedIntervals && selected < 300 && (providerChanged || !editId)) selected = 300;
  interval.innerHTML = intervalOptions(selected, provider);
  element('interval-warning').textContent = selected < 60 ? t('fastWarning') : provider === 'claude' ? t('claudeWarning') : '';
}
function renderEvents(): void {
  if (!eventsFetched) { element('events').innerHTML = `<div class="skeleton">${escape(t(connectionFailed ? 'neverConnected' : 'loading'))}</div>`; return; }
  element('events').innerHTML = events.length ? events.map(event => {
    const account = accounts.find(item => item.id === event.accountId);
    const kind = hasTranslation(`event.${event.kind}`) ? t(`event.${event.kind}`) : t('events');
    const prefix = `${event.accountId}:${event.kind}:`;
    const windowKey = event.dedupeKey.startsWith(prefix) ? event.dedupeKey.slice(prefix.length) : '';
    const historicalLabel = event.title.includes(' · ') ? event.title.slice(event.title.indexOf(' · ') + 3) : event.accountId;
    const historicalProvider = event.body.split(' · ')[0] ?? '';
    const quota = account?.windows.find(window => window.key === windowKey);
    const detail = [account?.provider ?? historicalProvider, windowKey && windowKey !== 'auth' ? windowLabel(quota ?? { key: windowKey, label: windowKey }) : ''].filter(Boolean).join(' · ');
    return `<article class="event"><span class="badge ${event.kind === 'recovered' ? 'good' : 'warn'}">${escape(kind)}</span><div><p>${escape(account?.label ?? historicalLabel)}</p><p class="hint">${escape(detail)}</p><time datetime="${new Date(event.at).toISOString()}">${escape(date(event.at))}</time></div></article>`;
  }).join('') : `<div class="empty"><p>${escape(t('emptyEvents'))}</p></div>`;
}
async function refreshEvents(): Promise<void> {
  events = (await api<{ events: NotificationEvent[] }>('/api/events')).events;
  eventsFetched = true; renderEvents();
}
function renderLoginModes(): void {
  if (!loginAccount) return;
  const device = loginAccount.provider === 'codex' || loginAccount.provider === 'grok';
  const modes = device ? ['device', ...(!cloud ? ['callback'] : [])] : ['paste', ...(!cloud ? ['callback'] : [])];
  element('login-mode').innerHTML = modes.map(mode => `<option value="${mode}">${escape(t(`${mode}Mode`))}</option>`).join('');
}
function openLogin(account: Account): void {
  clearTimeout(loginTimer); loginGeneration++; login = null; loginAccount = account;
  element('login-account').textContent = `${account.provider} · ${account.label}`;
  renderLoginModes(); element('login-start-form').hidden = false; element('login-flow').hidden = true;
  element<HTMLFormElement>('login-complete-form').reset(); element<HTMLButtonElement>('login-complete-form').querySelector<HTMLButtonElement>('button')!.disabled = false;
  element<HTMLDialogElement>('login-dialog').showModal();
}
function renderLogin(): void {
  if (!login) return;
  element('login-start-form').hidden = true; element('login-flow').hidden = false;
  element('login-instructions').textContent = t(`${login.mode}Instructions`);
  element('login-code').textContent = login.userCode ?? ''; element('login-code').hidden = !login.userCode;
  element('copy-code').hidden = !login.userCode;
  const link = element<HTMLAnchorElement>('login-link'); const url = login.verificationUri ?? login.authorizationUrl;
  try { const parsed = new URL(url ?? ''); link.hidden = parsed.protocol !== 'https:'; if (!link.hidden) link.href = parsed.href; } catch { link.hidden = true; }
  element('login-complete-form').hidden = login.mode !== 'paste' || login.status !== 'pending';
  element('login-state').textContent = login.status === 'complete' ? t('loginComplete') : login.status === 'error' ? errorText(login.error) : t('loginPending');
  element('login-state').className = login.status === 'error' ? 'error-text' : 'hint';
  updateClocks();
}
function scheduleLoginPoll(generation: number): void {
  clearTimeout(loginTimer);
  if (!login || login.status !== 'pending' || login.expiresAt <= Date.now() + serverOffset || generation !== loginGeneration) return;
  loginTimer = setTimeout(async () => {
    if (!login || generation !== loginGeneration) return;
    try {
      const current = login;
      const result = await api<{ login: Login }>(`/api/login/${current.provider}/status?id=${encodeURIComponent(current.id)}`);
      if (generation !== loginGeneration) return;
      login = result.login; renderLogin();
      if (login.status === 'complete') { toast('loginComplete'); await refreshStatus(); }
    } catch (error) {
      if (generation !== loginGeneration) return;
      element('login-state').textContent = errorText(error instanceof ApiError ? error.code : 'NETWORK');
    }
    scheduleLoginPoll(generation);
  }, 3000);
}
async function cancelLogin(): Promise<void> {
  clearTimeout(loginTimer); loginGeneration++;
  const current = login; login = null; loginAccount = null;
  element<HTMLDialogElement>('login-dialog').close();
  if (current?.status === 'pending') await api(`/api/login/${current.provider}/${encodeURIComponent(current.id)}`, 'DELETE');
}
async function updatePushStatus(): Promise<void> {
  const unsupported = !isSecureContext || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window);
  let subscribed = false;
  if (!unsupported && registration) {
    try { subscribed = Boolean(await registration.pushManager.getSubscription()); } catch { /* Capability is handled below. */ }
  }
  element('push-status').textContent = t(unsupported ? 'pushUnavailable' : Notification.permission === 'denied' ? 'pushDenied' : subscribed ? 'pushSubscribed' : 'pushNotSubscribed');
  element<HTMLButtonElement>('push-subscribe').disabled = unsupported || !registration || Notification.permission === 'denied';
  element<HTMLButtonElement>('push-unsubscribe').disabled = unsupported || !subscribed;
  element<HTMLButtonElement>('push-test').disabled = unsupported || !subscribed;
}
async function initializeWorker(): Promise<void> {
  if (!isSecureContext || !('serviceWorker' in navigator)) { await updatePushStatus(); return; }
  try { registration = await navigator.serviceWorker.register('/js/sw.js', { scope: '/' }); await navigator.serviceWorker.ready; }
  catch { registration = null; }
  await updatePushStatus();
}

function bindControls(): void {
  for (const form of document.querySelectorAll<HTMLFormElement>('form')) form.noValidate = true;
  element('locale').addEventListener('change', () => {
    const value = element<HTMLSelectElement>('locale').value; if (!validLocale(value)) return;
    setLocale(value); storageSet('gauge.locale', value); translateShell();
  });
  element('theme').addEventListener('change', () => { themePreference = element<HTMLSelectElement>('theme').value; storageSet('gauge.theme', themePreference); applyTheme(); });
  systemTheme.addEventListener('change', () => { if (themePreference === 'system') applyTheme(); });
  element('lock').addEventListener('click', requirePin);
  element<HTMLDialogElement>('pin-dialog').addEventListener('cancel', event => event.preventDefault());
  element<HTMLFormElement>('pin-form').addEventListener('submit', event => {
    event.preventDefault(); const form = event.currentTarget as HTMLFormElement;
    void perform(form, async () => {
      pin = field<HTMLInputElement>(form, 'pin').value; storageSet('gauge.pin', pin, true);
      pinErrorCode = null; element('pin-error').textContent = '';
      try { const state = await api<Status>('/api/status'); accounts = state.accounts; settings = state.settings; cloud = state.cloud; serverOffset = state.serverTime - Date.now(); lastConnected = Date.now(); connectionFailed = false; element<HTMLDialogElement>('pin-dialog').close(); field<HTMLInputElement>(form, 'pin').value = ''; element('lock').hidden = false; translateShell(); await refreshStatus(); }
      catch (error) { pinErrorCode = error instanceof ApiError ? error.code : 'NETWORK'; element('pin-error').textContent = errorText(pinErrorCode); throw error; }
    });
  });
  element('add-account').addEventListener('click', () => openAccount());
  element('refresh').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, () => refreshStatus(true)); });
  element('refresh-events').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, refreshEvents); });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) button.addEventListener('click', () => {
    activeTab = button.dataset.tab!;
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-current', tab === button ? 'page' : 'false'); }
    for (const name of ['accounts', 'events', 'settings']) element(`${name}-panel`).hidden = name !== activeTab;
    if (activeTab === 'events') void perform(button, refreshEvents);
    if (activeTab === 'settings') void updatePushStatus();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close]')) button.addEventListener('click', () => element<HTMLDialogElement>(button.dataset.close!).close());
  const accountForm = element<HTMLFormElement>('account-form');
  field<HTMLSelectElement>(accountForm, 'provider').addEventListener('change', () => updateAccountIntervals(true));
  field<HTMLSelectElement>(accountForm, 'interval').addEventListener('change', () => updateAccountIntervals(false));
  accountForm.addEventListener('submit', event => {
    event.preventDefault(); void perform(accountForm, async () => {
      const lowPct = Number(field<HTMLInputElement>(accountForm, 'lowPct').value); const recoverPct = Number(field<HTMLInputElement>(accountForm, 'recoverPct').value);
      if (recoverPct <= lowPct) { toast('thresholdInvalid'); return; }
      const label = field<HTMLInputElement>(accountForm, 'label').value.trim(); if (!label) throw new ApiError('VALIDATION');
      const body = { ...(!editId ? { provider: field<HTMLSelectElement>(accountForm, 'provider').value } : {}), label, interval: Number(field<HTMLSelectElement>(accountForm, 'interval').value), thresholds: { lowPct, recoverPct } };
      const result = await api<{ account: Account }>(editId ? `/api/accounts/${encodeURIComponent(editId)}` : '/api/accounts', editId ? 'PATCH' : 'POST', body);
      const wasNew = !editId; element<HTMLDialogElement>('account-dialog').close(); toast('saved'); await refreshStatus();
      if (wasNew) openLogin(result.account);
    });
  });
  element('accounts').addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]'); if (!button) return;
    if (button.dataset.action === 'add') { openAccount(); return; }
    const id = button.closest<HTMLElement>('[data-account-id]')?.dataset.accountId;
    const account = accounts.find(item => item.id === id); if (!account) return;
    if (button.dataset.action === 'edit') openAccount(account);
    if (button.dataset.action === 'login') openLogin(account);
    if (button.dataset.action === 'delete') { deleteId = account.id; element('delete-message').textContent = t('deleteConfirm', { name: account.label }); element<HTMLDialogElement>('confirm-dialog').showModal(); }
    if (button.dataset.action === 'check') void perform(button, async () => {
      let result: { account: Account };
      try { result = await api<{ account: Account }>(`/api/accounts/${encodeURIComponent(account.id)}/check`, 'POST'); }
      catch (error) { if (!(error instanceof ApiError && error.code === 'AUTH_REQUIRED')) await refreshStatus(); throw error; }
      await refreshStatus();
      if (result.account.error) showError(new ApiError(result.account.errorCode ?? 'generic')); else toast('checked');
    });
  });
  element('confirm-delete').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, async () => { if (!deleteId) return; await api(`/api/accounts/${encodeURIComponent(deleteId)}`, 'DELETE'); deleteId = null; element<HTMLDialogElement>('confirm-dialog').close(); toast('deleted'); await refreshStatus(); }); });
  const settingsForm = element<HTMLFormElement>('settings-form');
  settingsForm.addEventListener('input', () => {
    settingsForm.dataset.dirty = 'true';
    element('default-interval-warning').hidden = Number(field<HTMLSelectElement>(settingsForm, 'defaultInterval').value) >= 60;
  });
  settingsForm.addEventListener('submit', event => {
    event.preventDefault(); void perform(settingsForm, async () => {
      const body = { defaultInterval: Number(field<HTMLSelectElement>(settingsForm, 'defaultInterval').value), defaultLocale: field<HTMLSelectElement>(settingsForm, 'defaultLocale').value, defaultTheme: field<HTMLSelectElement>(settingsForm, 'defaultTheme').value, cooldownHours: Number(field<HTMLInputElement>(settingsForm, 'cooldownHours').value), advancedIntervals: field<HTMLInputElement>(settingsForm, 'advancedIntervals').checked, push: field<HTMLInputElement>(settingsForm, 'push').checked };
      settings = (await api<{ settings: Settings }>('/api/settings', 'PUT', body)).settings;
      settingsForm.dataset.dirty = 'false'; populateSettings(true); toast('saved'); await refreshStatus();
    });
  });
  const startForm = element<HTMLFormElement>('login-start-form');
  startForm.addEventListener('submit', event => {
    event.preventDefault(); if (!loginAccount) return;
    // Open synchronously to preserve the user gesture; the server supplies the actual destination.
    const popup = window.open('about:blank', '_blank'); if (popup) popup.opener = null;
    const currentAccount = loginAccount; const generation = ++loginGeneration;
    void perform(startForm, async () => {
      try {
        const result = await api<{ login: Login }>(`/api/login/${currentAccount.provider}/start`, 'POST', { accountId: currentAccount.id, mode: element<HTMLSelectElement>('login-mode').value });
        if (generation !== loginGeneration) { popup?.close(); if (result.login.status === 'pending') await api(`/api/login/${currentAccount.provider}/${encodeURIComponent(result.login.id)}`, 'DELETE'); return; }
        login = result.login; renderLogin();
        const link = element<HTMLAnchorElement>('login-link'); if (popup && !link.hidden) popup.location.href = link.href; else popup?.close();
        scheduleLoginPoll(generation);
      } catch (error) { popup?.close(); throw error; }
    });
  });
  element('cancel-login').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, cancelLogin); });
  element<HTMLDialogElement>('login-dialog').addEventListener('cancel', event => { event.preventDefault(); void cancelLogin().catch(showError); });
  const completeForm = element<HTMLFormElement>('login-complete-form');
  completeForm.addEventListener('submit', event => {
    event.preventDefault(); void perform(completeForm, async () => {
      if (!login) return; const current = login; const generation = loginGeneration;
      const input = field<HTMLTextAreaElement>(completeForm, 'input').value.trim();
      const result = await api<{ login: Login }>(`/api/login/${current.provider}/complete`, 'POST', { loginId: current.id, input });
      if (generation !== loginGeneration) return;
      field<HTMLTextAreaElement>(completeForm, 'input').value = ''; login = result.login; renderLogin();
      if (login.status === 'complete') { clearTimeout(loginTimer); toast('loginComplete'); await refreshStatus(); } else scheduleLoginPoll(generation);
    });
  });
  element('copy-code').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, async () => { if (login?.userCode) { await navigator.clipboard.writeText(login.userCode); toast('copied'); } }); });
  element('push-subscribe').addEventListener('click', event => {
    // Request permission immediately from the gesture, before network or worker waits.
    const permission = 'Notification' in window ? Notification.requestPermission() : Promise.resolve('denied' as NotificationPermission);
    void perform(event.currentTarget as HTMLButtonElement, async () => {
      if (await permission !== 'granted') { toast('pushDenied'); await updatePushStatus(); return; }
      if (!registration) throw new ApiError('PUSH_FAILED');
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        const { publicKey } = await api<{ publicKey: string }>('/api/push/vapid-public-key');
        const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
        const key = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), character => character.charCodeAt(0));
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await api('/api/push/subscribe', 'POST', subscription.toJSON()); toast('pushSuccess'); await updatePushStatus();
    });
  });
  element('push-unsubscribe').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, async () => {
    const subscription = await registration?.pushManager.getSubscription(); if (!subscription) return;
    await api('/api/push/subscribe', 'DELETE', { endpoint: subscription.endpoint });
    await subscription.unsubscribe(); toast('pushRemoved'); await updatePushStatus();
  }); });
  element('push-test').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, async () => { const result = await api<{ sent: number; failed: number }>('/api/push/test', 'POST'); toast(result.sent ? 'pushResult' : 'pushNone', { sent: number(result.sent), failed: number(result.failed) }); }); });
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event as InstallPrompt; element('install').hidden = false; });
  window.addEventListener('appinstalled', () => { installPrompt = null; element('install').hidden = true; });
  element('install').addEventListener('click', event => { void perform(event.currentTarget as HTMLButtonElement, async () => { if (!installPrompt) { toast('installUnavailable'); return; } await installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; element('install').hidden = true; }); });
  window.addEventListener('online', () => { void refreshStatus(); renderConnection(); });
  window.addEventListener('offline', renderConnection);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { void refreshStatus(); if (activeTab === 'events') void refreshEvents().catch(showError); updateClocks(); } });
}

applyTheme();
try {
  await initializeLocales(); bindControls(); translateShell();
  void initializeWorker(); await refreshStatus();
  setInterval(updateClocks, 1000);
  setInterval(() => { if (!document.hidden && pendingTasks === 0) { void refreshStatus(); if (activeTab === 'events' && !element<HTMLDialogElement>('pin-dialog').open) void refreshEvents().catch(() => { /* Status polling exposes connectivity without repeated toasts. */ }); } }, 30000);
} catch {
  element('connection').textContent = t('networkError') || element('connection').textContent;
}
