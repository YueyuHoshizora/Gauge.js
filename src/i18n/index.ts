import { readFileSync } from 'node:fs';
import type { Locale } from '../types.js';

const dictionaries: Record<Locale, Record<string,string>> = {
  'zh-TW': JSON.parse(readFileSync('public/locales/zh-TW.json','utf8')) as Record<string,string>,
  en: JSON.parse(readFileSync('public/locales/en.json','utf8')) as Record<string,string>,
  ja: JSON.parse(readFileSync('public/locales/ja.json','utf8')) as Record<string,string>,
};
export function t(locale: Locale, key: string, params: Record<string,string|number> = {}): string {
  const value = dictionaries[locale][key] ?? dictionaries['zh-TW'][key] ?? dictionaries.en[key] ?? key;
  return value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''));
}
export function duration(locale: Locale, milliseconds: number): string {
  const seconds = Math.max(0,Math.ceil(milliseconds/1000));
  const [key,amount] = seconds < 60 ? ['seconds',seconds] : seconds < 3600 ? ['minutes',Math.ceil(seconds/60)] : seconds < 86400 ? ['hours',seconds/3600] : ['days',seconds/86400];
  return t(locale,String(key),{value:new Intl.NumberFormat(locale,{maximumFractionDigits:1}).format(Number(amount))});
}
