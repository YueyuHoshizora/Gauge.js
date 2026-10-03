import { scryptSync, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { AppError } from './types.js';

export interface Config { port: number; host: string; cloud: boolean; origin: string; pin: string|null; dataDir: string; vapidSubject: string }
export function configuration(environment: NodeJS.ProcessEnv = process.env): Config {
  const cloud = environment.GAUGE_CLOUD === '1' || !!environment.REPL_ID || !!environment.REPLIT_DEPLOYMENT || (!!environment.HOST && !['127.0.0.1','localhost','::1'].includes(environment.HOST));
  const port = Number(environment.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between 1 and 65535');
  const pin = environment.GAUGE_PIN || null;
  if (cloud && (!pin || pin.length < 8)) throw new Error('Cloud hosting requires GAUGE_PIN with at least 8 characters');
  if (pin && pin.length > 256) throw new Error('GAUGE_PIN must be at most 256 characters');
  const configuredOrigin = environment.GAUGE_ORIGIN || (environment.REPLIT_DEV_DOMAIN ? `https://${environment.REPLIT_DEV_DOMAIN}` : null);
  if (cloud && !configuredOrigin) throw new Error('Cloud hosting requires GAUGE_ORIGIN=https://your-public-host');
  const origin = new URL(configuredOrigin ?? `http://localhost:${port}`);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !['http:','https:'].includes(origin.protocol) || (cloud && origin.protocol !== 'https:')) throw new Error('GAUGE_ORIGIN must be a bare HTTPS origin (HTTP is allowed only locally)');
  const vapidSubject = environment.VAPID_SUBJECT ?? 'mailto:gauge@localhost';
  if (!/^(mailto:[^\s]+@[^\s]+|https:\/\/[^\s]+)$/.test(vapidSubject)) throw new Error('VAPID_SUBJECT must be a contact mailto: or HTTPS URL');
  return {port,host: cloud ? environment.HOST ?? '0.0.0.0' : environment.HOST ?? '127.0.0.1',cloud,origin:origin.origin,pin,dataDir:environment.GAUGE_DATA_DIR ?? 'data',vapidSubject};
}
export class AccessControl {
  private pinHash: Buffer|null;
  private attempts = new Map<string,{count:number;until:number}>();
  constructor(private config: Config) { this.pinHash = config.pin ? scryptSync(config.pin,'Gauge.js access PIN',32) : null; }
  checkHost(req: IncomingMessage): void {
    const host = req.headers.host?.toLowerCase();
    const allowed = this.config.cloud ? [new URL(this.config.origin).host.toLowerCase()] : [new URL(this.config.origin).host.toLowerCase(),`localhost:${this.config.port}`,`127.0.0.1:${this.config.port}`,`[::1]:${this.config.port}`];
    if (!host || !allowed.includes(host)) throw new AppError('invalid_host','Host not allowed',403);
    const origin = req.headers.origin;
    const localOrigins = this.config.cloud ? [this.config.origin] : allowed.map(value => `http://${value}`).concat(this.config.origin);
    if (origin && !localOrigins.includes(origin)) throw new AppError('invalid_origin','Origin not allowed',403);
    if (req.headers['sec-fetch-site'] === 'cross-site' && req.url?.startsWith('/api/')) throw new AppError('invalid_origin','Cross-site API requests are not allowed',403);
  }
  authorize(req: IncomingMessage): void {
    if (!this.pinHash) return;
    const ip = req.socket.remoteAddress ?? 'unknown'; const now = Date.now();
    const attempt = this.attempts.get(ip);
    if (attempt && attempt.until > now && attempt.count >= 10) throw new AppError('rate_limited','Too many unsuccessful PIN attempts. Try again in one minute.',429,60);
    const supplied = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';
    // Hash both sides to keep comparison fixed-length without logging credentials.
    const valid = supplied.length > 0 && supplied.length <= 256 && timingSafeEqual(scryptSync(supplied,'Gauge.js access PIN',32),this.pinHash);
    if (!valid) {
      if (this.attempts.size >= 1000) for (const [key,value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
      if (this.attempts.size >= 1000) this.attempts.delete(this.attempts.keys().next().value ?? '');
      this.attempts.set(ip,{count: attempt && attempt.until > now ? attempt.count+1 : 1,until: attempt && attempt.until > now ? attempt.until : now+60_000});
      throw new AppError('auth_required','Access PIN required',401);
    }
    this.attempts.delete(ip);
  }
}
