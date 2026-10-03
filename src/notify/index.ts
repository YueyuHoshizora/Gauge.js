import { Store, type EventRecord } from '../store/index.js';
import { sendPush, createVapidKeys } from '../push/index.js';
import type { Account, NotificationPayload, QuotaWindow } from '../types.js';
import { t, duration } from '../i18n/index.js';

export class Notifier {
  readonly keys: { publicKey: string; privateKey: string };
  constructor(private store: Store, private subject: string) { const stored = store.setting<{publicKey:string;privateKey:string} | null>('vapid',null); this.keys = stored ?? createVapidKeys(); if (!stored) store.putSetting('vapid',this.keys); }
  async broadcast(payload: NotificationPayload): Promise<{sent:number;failed:number}> {
    let sent = 0; let failed = 0;
    const subscriptions = this.store.subscriptions();
    // Bounded batches prevent a large subscription list from exhausting sockets.
    for (let start = 0; start < subscriptions.length; start += 8) await Promise.all(subscriptions.slice(start,start+8).map(async subscription => {
      try { const result = await sendPush(subscription,payload,this.keys,this.subject); if (result.status === 404 || result.status === 410) this.store.unsubscribe(subscription.endpoint); if (result.status >= 200 && result.status < 300) sent++; else failed++; } catch { failed++; }
    }));
    return {sent,failed};
  }
  async test(): Promise<{sent:number;failed:number}> { const locale = this.store.settings().defaultLocale; return this.broadcast({title:`Gauge.js · ${t(locale,'event.test')}`,body:t(locale,'pushSuccess'),tag:'gauge-test',url:'/'}); }
  async quota(account: Account, previous: QuotaWindow[], now = Date.now()): Promise<void> {
    const pending: EventRecord[] = [];
    this.store.transaction(() => {
      for (const window of account.windows) {
        const before = previous.find(value => value.key === window.key);
        const persisted = this.store.lowState(account.id,window.key);
        const wasLow = persisted ?? (before ? before.remainingPct <= account.thresholds.lowPct : false);
        const isLow = window.remainingPct <= account.thresholds.lowPct;
        let kind: 'low'|'recovered'|null = null;
        let nextLow = wasLow;
        if (isLow) { nextLow = true; if (!wasLow && (before || persisted !== null)) kind = 'low'; }
        else if (wasLow && (window.remainingPct >= account.thresholds.recoverPct || (before?.resetsAt && Date.parse(before.resetsAt) <= now && window.remainingPct > before.remainingPct))) { nextLow = false; kind = 'recovered'; }
        this.store.setLowState(account.id,window.key,nextLow);
        if (kind) { const event = this.record(account,kind,window,now); if (event) pending.push(event); }
      }
    });
    if (this.store.settings().push) for (const event of pending) await this.broadcast({title:event.title,body:event.body,tag:event.dedupeKey,url:'/'});
  }
  async authExpired(account: Account, now = Date.now()): Promise<void> { const event = this.record(account,'auth_expired',null,now); if (event && this.store.settings().push) await this.broadcast({title:event.title,body:event.body,tag:event.dedupeKey,url:'/'}); }
  private record(account: Account, kind: 'low'|'recovered'|'auth_expired', window: QuotaWindow|null, at:number): EventRecord|null {
    const locale = this.store.settings().defaultLocale;
    const remaining = window ? new Intl.NumberFormat(locale,{style:'percent',maximumFractionDigits:1}).format(window.remainingPct/100) : '';
    const reset = window?.resetsAt ? t(locale,'resetIn',{duration:duration(locale,Date.parse(window.resetsAt)-at)}) : t(locale,'resetUnknown');
    const labelKey = `window.${window?.key}`;
    let label = window ? t(locale,labelKey) : '';
    if (window && label === labelKey) {
      if (window.key.startsWith('seven_day_')) label = `${window.label.split(' · ')[0]} · ${t(locale,'window.seven_day')}`;
      else if (window.key.endsWith('.primary') || window.key.endsWith('.secondary')) { const part = window.key.endsWith('.primary') ? 'primary' : 'secondary'; label = `${window.key.slice(0,-part.length-1)} · ${t(locale,`window.${part}`)}`; }
      else label = window.label;
    }
    return this.store.event({accountId:account.id,kind,title:`${t(locale,`event.${kind}`)} · ${account.label}`,body:`${account.provider}${window ? ` · ${label} · ${t(locale,'remaining')} ${remaining} · ${reset}` : ''}`,at,dedupeKey:`${account.id}:${kind}:${window?.key ?? 'auth'}`},this.store.settings().cooldownHours * 3_600_000);
  }
}
