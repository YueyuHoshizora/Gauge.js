export type Locale = 'zh-TW' | 'en' | 'ja';
type Dictionary = Record<string, string>;
const dictionaries: Partial<Record<Locale, Dictionary>> = {};
export let locale: Locale = 'zh-TW';
const numberFormats = new Map<number, Intl.NumberFormat>();
let percentFormat = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
let dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
let timeFormat = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function storageGet(key: string, session = false): string | null {
  try { return (session ? sessionStorage : localStorage).getItem(key); } catch { return null; }
}
export function storageSet(key: string, value: string | null, session = false): void {
  try { const storage = session ? sessionStorage : localStorage; if (value === null) storage.removeItem(key); else storage.setItem(key, value); } catch { /* Restricted storage still permits an in-memory session. */ }
}
export function validLocale(value: string | null | undefined): value is Locale { return value === 'en' || value === 'ja' || value === 'zh-TW'; }
export function browserLocale(): Locale {
  const preferred = storageGet('gauge.locale');
  if (validLocale(preferred)) return preferred;
  const language = navigator.language.toLowerCase();
  return language.startsWith('en') ? 'en' : language.startsWith('ja') ? 'ja' : 'zh-TW';
}
export async function initializeLocales(): Promise<void> {
  await Promise.all((['en', 'zh-TW', 'ja'] as const).map(async language => {
    const response = await fetch(`/locales/${language}.json`, { cache: 'no-cache' });
    if (!response.ok) throw new Error('dictionary');
    dictionaries[language] = await response.json() as Dictionary;
  }));
  setLocale(browserLocale());
}
export function setLocale(value: Locale): void {
  if (locale !== value) {
    numberFormats.clear();
    percentFormat = new Intl.NumberFormat(value, { style: 'percent', maximumFractionDigits: 1 });
    dateFormat = new Intl.DateTimeFormat(value, { dateStyle: 'medium', timeStyle: 'short' });
    timeFormat = new Intl.DateTimeFormat(value, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  locale = value; document.documentElement.lang = value;
}
export function hasTranslation(key: string): boolean { return Boolean(dictionaries[locale]?.[key] ?? dictionaries['zh-TW']?.[key] ?? dictionaries.en?.[key]); }
export function t(key: string, values: Record<string, string | number> = {}): string {
  const text = dictionaries[locale]?.[key] ?? dictionaries['zh-TW']?.[key] ?? dictionaries.en?.[key] ?? dictionaries[locale]?.genericError ?? '';
  return text.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? ''));
}
export function number(value: number, digits = 0): string {
  let formatter = numberFormats.get(digits);
  if (!formatter) { formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }); numberFormats.set(digits, formatter); }
  return formatter.format(value);
}
export function percent(value: number): string { return percentFormat.format(value / 100); }
export function date(value: number | string): string { return dateFormat.format(new Date(value)); }
export function time(value: number): string { return timeFormat.format(value); }
export function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  if (seconds < 60) return t('seconds', { value: number(seconds) });
  if (seconds < 3600) return t('minutes', { value: number(Math.ceil(seconds / 60)) });
  if (seconds < 86400) return t('hours', { value: number(seconds / 3600, 1) });
  return t('days', { value: number(seconds / 86400, 1) });
}
export function errorText(code?: string | null): string {
  const normalized = (code ?? '').toUpperCase();
  if (hasTranslation(`error.${normalized}`)) return t(`error.${normalized}`);
  if (/AUTH_REQUIRED|UNAUTHORIZED|PIN/.test(normalized)) return t('authRequired');
  if (/NOT_FOUND/.test(normalized)) return t('notFound');
  if (/RATE_LIMIT|TOO_MANY/.test(normalized)) return t('rateLimited');
  if (/VALIDATION|INVALID|BAD_REQUEST|JSON|INTERVAL|THRESHOLD/.test(normalized)) return t('validationError');
  if (/NETWORK/.test(normalized)) return t('networkError');
  return t('genericError');
}
