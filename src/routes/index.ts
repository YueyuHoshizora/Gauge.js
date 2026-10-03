import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { AppError, PROVIDERS, type ProviderId } from '../types.js';
import { Store } from '../store/index.js';
import { Scheduler } from '../scheduler/index.js';
import { Notifier } from '../notify/index.js';
import { LoginManager } from '../auth/index.js';
import { validateSubscription } from '../push/index.js';
import { AccessControl, type Config } from '../security.js';

export interface Application { server: Server; store: Store; scheduler: Scheduler; notifier: Notifier; login: LoginManager; close(): Promise<void> }
async function body(req: IncomingMessage): Promise<Record<string,unknown>> {
  if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new AppError('invalid_content_type','Use application/json',415);
  let length = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); length += buffer.length; if (length > 16_384) throw new AppError('request_too_large','Request body too large',413); chunks.push(buffer); }
  try { const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(); return parsed as Record<string,unknown>; } catch { throw new AppError('invalid_json','Invalid JSON object'); }
}
function json(res: ServerResponse, status: number, value: unknown): void { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); }
const mime: Record<string,string> = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
export function createApplication(config: Config): Application {
  const store = new Store(config.dataDir); const notifier = new Notifier(store,config.vapidSubject); const scheduler = new Scheduler(store,notifier); const access = new AccessControl(config);
  const startedAt = Date.now(); const sessions = new Map<string,{provider:ProviderId;accountId:string}>();
  const login = new LoginManager({cloud:config.cloud,port:config.port,onAuth:async (id,auth) => { store.get(id); store.setAuth(id,auth); void scheduler.check(id).catch(() => {}); }});
  const publicDirectory = resolve('public');
  const server = createServer((req,res) => { void handle(req,res).catch(error => {
    if (res.headersSent) { res.destroy(); return; }
    const safe = error instanceof AppError ? error : new AppError('internal_error','Unexpected server error',500);
    if (safe.retryAfter) res.setHeader('Retry-After',String(safe.retryAfter));
    json(res,safe.status,{error:{code:safe.code,message:safe.message}});
  }); });
  server.requestTimeout = 30_000; server.headersTimeout = 10_000; server.maxHeadersCount = 50;
  async function handle(req: IncomingMessage,res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    if (config.cloud) res.setHeader('Strict-Transport-Security','max-age=31536000');
    access.checkHost(req);
    const url = new URL(req.url ?? '/',config.origin); const path = url.pathname; const method = req.method ?? 'GET';
    if (!config.cloud && method === 'GET' && (path === '/callback' || path === '/oauth2callback')) { await login.callback(path === '/callback' ? 'claude' : 'antigravity',url.searchParams); res.writeHead(303,{Location:'/', 'Cache-Control':'no-store'}); res.end(); return; }
    if (!path.startsWith('/api/')) {
      if (!['GET','HEAD'].includes(method)) throw new AppError('method_not_allowed','Method not allowed',405);
      let decoded: string; try { decoded = decodeURIComponent(path); } catch { throw new AppError('not_found','Not found',404); }
      if (decoded.split('/').some(part => part.startsWith('.')) || decoded.includes('\\') || decoded.includes('\0')) throw new AppError('not_found','Not found',404);
      const file = resolve(publicDirectory,'.'+(decoded === '/' ? '/index.html' : decoded));
      if (!file.startsWith(publicDirectory+sep) || !mime[extname(file)]) throw new AppError('not_found','Not found',404);
      try { const details = await stat(file); if (!details.isFile()) throw new Error(); const data = method === 'HEAD' ? null : await readFile(file); res.setHeader('Content-Type',mime[extname(file)]!); res.setHeader('Cache-Control','no-cache'); if (path === '/js/sw.js' || path === '/sw.js') res.setHeader('Service-Worker-Allowed','/'); res.end(data); } catch { throw new AppError('not_found','Not found',404); }
      return;
    }
    access.authorize(req);
    if (path === '/api/status' && method === 'GET') return json(res,200,{accounts:store.accounts().map(account => store.public(account)),serverTime:Date.now(),startedAt,cloud:config.cloud,settings:store.settings()});
    if (path === '/api/accounts') {
      if (method === 'GET') return json(res,200,{accounts:store.accounts().map(account => store.public(account))});
      if (method === 'POST') return json(res,201,{account:store.create(await body(req))});
    }
    const accountMatch = /^\/api\/accounts\/([^/]+)(\/check)?$/.exec(path);
    if (accountMatch) {
      const id = accountMatch[1]!;
      if (accountMatch[2] && method === 'POST') { await scheduler.check(id); return json(res,200,{account:store.public(store.get(id))}); }
      if (!accountMatch[2] && method === 'PATCH') { const account = store.update(id,await body(req)); scheduler.reschedule(id); return json(res,200,{account}); }
      if (!accountMatch[2] && method === 'DELETE') {
        store.get(id);
        for (const [sessionId,session] of sessions) if (session.accountId === id) {
          try { login.cancel(session.provider,sessionId); } catch (error) { if (!(error instanceof AppError && error.code === 'LOGIN_NOT_FOUND')) throw error; }
          sessions.delete(sessionId);
        }
        store.delete(id); return json(res,200,{deleted:true});
      }
    }
    const loginMatch = /^\/api\/login\/([^/]+)\/(start|complete|status|[^/]+)$/.exec(path);
    if (loginMatch) {
      const provider = loginMatch[1] as ProviderId; if (!(PROVIDERS as readonly string[]).includes(provider)) throw new AppError('invalid_provider','Unknown provider');
      const action = loginMatch[2];
      if (action === 'start' && method === 'POST') {
        const input = await body(req); if (typeof input.accountId !== 'string' || (input.mode !== undefined && typeof input.mode !== 'string')) throw new AppError('invalid_input','Expected accountId and optional login mode');
        const account = store.get(input.accountId); if (account.provider !== provider) throw new AppError('invalid_provider','Account belongs to another provider');
        for (const [sessionId,session] of sessions) if (session.accountId === account.id) {
          try { login.cancel(session.provider,sessionId); } catch (error) { if (!(error instanceof AppError && error.code === 'LOGIN_NOT_FOUND')) throw error; }
          sessions.delete(sessionId);
        }
        const view = await login.start(provider,account.id,input.mode as string|undefined);
        try { store.get(account.id); } catch (error) { login.cancel(provider,view.id); throw error; }
        sessions.set(view.id,{provider,accountId:account.id});
        for (const [sessionId,session] of sessions) { try { login.status(session.provider,sessionId); } catch { sessions.delete(sessionId); } }
        return json(res,200,{login:view});
      }
      if (action === 'status' && method === 'GET') { const id = url.searchParams.get('id') ?? ''; const view = login.status(provider,id); store.get(view.accountId); return json(res,200,{login:view}); }
      if (action === 'complete' && method === 'POST') { const input = await body(req); if (typeof input.loginId !== 'string' || typeof input.input !== 'string' || input.input.length > 8192) throw new AppError('invalid_input','Expected loginId and code or callback URL'); const view = login.status(provider,input.loginId); store.get(view.accountId); return json(res,200,{login:await login.complete(provider,input.loginId,input.input)}); }
      if (method === 'DELETE' && action) { login.cancel(provider,action); sessions.delete(action); return json(res,200,{cancelled:true}); }
    }
    if (path === '/api/settings') { if (method === 'GET') return json(res,200,{settings:store.settings()}); if (method === 'PUT') return json(res,200,{settings:store.updateSettings(await body(req))}); }
    if (path === '/api/events' && method === 'GET') return json(res,200,{events:store.events()});
    if (path === '/api/push/vapid-public-key' && method === 'GET') return json(res,200,{publicKey:notifier.keys.publicKey});
    if (path === '/api/push/subscribe') {
      if (method === 'POST') { const subscription = validateSubscription(await body(req)); store.subscribe(subscription,req.headers['user-agent'] ?? ''); return json(res,200,{subscribed:true}); }
      if (method === 'DELETE') { const input = await body(req); if (typeof input.endpoint !== 'string') throw new AppError('invalid_input','Expected subscription endpoint'); store.unsubscribe(input.endpoint); return json(res,200,{subscribed:false}); }
    }
    if (path === '/api/push/test' && method === 'POST') return json(res,200,await notifier.test());
    throw new AppError('not_found','API route not found',404);
  }
  return {server,store,scheduler,notifier,login,async close() { login.close(); await scheduler.stop(); if (server.listening) await new Promise<void>((resolveClose,reject) => server.close(error => error ? reject(error) : resolveClose())); store.close(); }};
}
