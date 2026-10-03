import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AppError, type Auth, type LoginContext, type LoginView, type ProviderId } from '../types.js';
import { claims, expect, form, json, number, object, request, schema, text, tokens, type ObjectValue } from '../providers/common.js';
import { CLAUDE_CLIENT, claudeToken } from '../providers/claude.js';
import { CODEX_CLIENT } from '../providers/codex.js';
import { GROK_CLIENT, GROK_SCOPE } from '../providers/grok.js';
import { GOOGLE_CLIENT, GOOGLE_CLIENT_SECRET } from '../providers/antigravity.js';

interface Session {
  view: LoginView; state: string; verifier: string; nonce: string; redirect: string;
  abort: AbortController; deviceCode?: string; interval: number; busy: boolean;
  timer?: NodeJS.Timeout; expiry?: NodeJS.Timeout; server?: Server;
}
function equal(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }

export class LoginManager {
  private readonly sessions = new Map<string, Session>();
  private closed = false;
  constructor(private readonly context: LoginContext) {}

  private view(session: Session): LoginView { return { ...session.view }; }
  private active(session: Session): boolean { return !this.closed && session.view.status === 'pending' && !session.abort.signal.aborted && Date.now() < session.view.expiresAt; }
  private release(session: Session): void {
    clearTimeout(session.timer); clearTimeout(session.expiry); session.abort.abort();
    session.server?.close(); session.server?.closeIdleConnections(); session.server = undefined;
    session.state = ''; session.verifier = ''; session.nonce = ''; session.deviceCode = undefined;
    delete session.view.authorizationUrl; delete session.view.userCode; delete session.view.verificationUri;
    // Retain a short, secret-free terminal status for the dashboard poller.
    session.expiry = setTimeout(() => this.sessions.delete(session.view.id), 300_000); session.expiry.unref();
  }
  private fail(session: Session, error: unknown): void {
    if (session.view.status !== 'pending') return;
    session.view.status = 'error'; session.view.error = error instanceof AppError ? error.code : 'UPSTREAM_ERROR'; this.release(session);
  }
  private require(provider: ProviderId, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.view.provider !== provider) throw new AppError('LOGIN_NOT_FOUND', 'Login session was not found.', 404);
    if (session.view.status === 'pending' && Date.now() >= session.view.expiresAt) this.fail(session, new AppError('LOGIN_EXPIRED', 'Login session expired.'));
    return session;
  }
  status(provider: ProviderId, id: string): LoginView { return this.view(this.require(provider, id)); }
  cancel(provider: ProviderId, id: string): void { this.fail(this.require(provider, id), new AppError('LOGIN_CANCELLED', 'Login was cancelled.')); }
  close(): void {
    this.closed = true;
    for (const session of this.sessions.values()) { clearTimeout(session.timer); clearTimeout(session.expiry); session.abort.abort(); session.server?.close(); session.server?.closeAllConnections(); session.state = ''; session.verifier = ''; session.nonce = ''; session.deviceCode = undefined; }
    this.sessions.clear();
  }

  async start(provider: ProviderId, accountId: string, mode?: string): Promise<LoginView> {
    if (this.closed || !accountId || !['codex', 'grok', 'claude', 'antigravity'].includes(provider)) throw new AppError('LOGIN_INPUT', 'Invalid login request.');
    const selected = mode ?? (provider === 'codex' || provider === 'grok' ? 'device' : this.context.cloud ? 'paste' : 'callback');
    if (!['device', 'paste', 'callback'].includes(selected) || (selected === 'device' && provider !== 'codex' && provider !== 'grok') || (selected === 'callback' && this.context.cloud)) throw new AppError('LOGIN_MODE', 'This login mode is not available.');
    for (const previous of this.sessions.values()) if (previous.view.accountId === accountId && previous.view.status === 'pending') this.fail(previous, new AppError('LOGIN_CANCELLED', 'Login was replaced.'));
    if (this.sessions.size >= 128) throw new AppError('LOGIN_INPUT', 'Too many login sessions. Try again later.', 429);
    const session: Session = {
      view: { id: randomBytes(24).toString('base64url'), accountId, provider, status: 'pending', mode: selected as LoginView['mode'], expiresAt: Date.now() + 900_000 },
      state: randomBytes(32).toString('base64url'), verifier: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'), redirect: '', abort: new AbortController(), interval: 5, busy: false,
    };
    this.sessions.set(session.view.id, session);
    session.expiry = setTimeout(() => this.fail(session, new AppError('LOGIN_EXPIRED', 'Login session expired.')), 900_000); session.expiry.unref();
    try {
      if (selected === 'device') await this.device(session);
      else {
        if (provider === 'codex') session.redirect = 'http://localhost:1455/auth/callback';
        else if (provider === 'grok') session.redirect = 'http://127.0.0.1:56121/callback';
        else if (provider === 'claude') session.redirect = selected === 'paste' ? 'https://console.anthropic.com/oauth/code/callback' : `http://localhost:${this.context.port}/callback`;
        else session.redirect = `http://127.0.0.1:${this.context.port}/oauth2callback`;
        if (selected === 'callback' && (provider === 'codex' || provider === 'grok')) await this.listen(session);
        const challenge = createHash('sha256').update(session.verifier).digest('base64url');
        const params = new URLSearchParams({ response_type: 'code', redirect_uri: session.redirect, state: session.state, code_challenge: challenge, code_challenge_method: 'S256' });
        let endpoint: string;
        if (provider === 'codex') { endpoint = 'https://auth.openai.com/oauth/authorize'; params.set('client_id', CODEX_CLIENT); params.set('scope', 'openid profile email offline_access api.connectors.read api.connectors.invoke'); params.set('codex_cli_simplified_flow', 'true'); params.set('id_token_add_organizations', 'true'); params.set('originator', 'codex_cli_rs'); }
        else if (provider === 'grok') { endpoint = 'https://auth.x.ai/oauth2/authorize'; params.set('client_id', GROK_CLIENT); params.set('scope', GROK_SCOPE); params.set('nonce', session.nonce); }
        else if (provider === 'claude') { endpoint = 'https://claude.ai/oauth/authorize'; params.set('client_id', CLAUDE_CLIENT); params.set('scope', 'user:profile user:inference'); params.set('code', 'true'); }
        else { endpoint = 'https://accounts.google.com/o/oauth2/v2/auth'; params.set('client_id', GOOGLE_CLIENT); params.set('scope', 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile'); params.set('access_type', 'offline'); params.set('prompt', 'consent'); }
        session.view.authorizationUrl = `${endpoint}?${params}`;
      }
      if (!this.active(session)) throw new AppError('LOGIN_CANCELLED', 'Login was cancelled.');
      return this.view(session);
    } catch (error) { this.fail(session, error); throw error instanceof AppError ? error : new AppError('UPSTREAM_ERROR', 'Login could not be started.', 502); }
  }

  private async listen(session: Session): Promise<void> {
    const redirect = new URL(session.redirect);
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      if (req.method !== 'GET' || !req.url || req.url.length > 16_384 || ![redirect.host, `127.0.0.1:${redirect.port}`, `localhost:${redirect.port}`].includes(req.headers.host ?? '')) { res.writeHead(400); res.end('Invalid callback.'); return; }
      const url = new URL(req.url, session.redirect);
      if (url.pathname !== redirect.pathname) { res.writeHead(404); res.end(); return; }
      void this.accept(session, url.searchParams).then(() => { res.writeHead(302, { Location: `http://localhost:${this.context.port}/` }); res.end(); }).catch(() => { res.writeHead(400); res.end('Login failed. Return to Gauge.js to see the login status.'); });
    });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    session.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new AppError('LOGIN_PORT_BUSY', `Callback port ${redirect.port} is unavailable. Close the CLI using it or choose device login.`, 409)));
      server.listen(Number(redirect.port), '127.0.0.1', resolve);
    });
    if (!this.active(session)) { server.close(); throw new AppError('LOGIN_CANCELLED', 'Login was cancelled.'); }
  }

  private async device(session: Session): Promise<void> {
    const codex = session.view.provider === 'codex';
    const response = await request(codex ? 'https://auth.openai.com/api/accounts/deviceauth/usercode' : 'https://auth.x.ai/oauth2/device/code', codex ? json({ client_id: CODEX_CLIENT }) : form({ client_id: GROK_CLIENT, scope: GROK_SCOPE }), session.abort.signal);
    const data = expect(response); const userCode = text(data.user_code) ?? text(data.usercode); const deviceCode = text(codex ? data.device_auth_id : data.device_code);
    if (!userCode || !deviceCode) schema();
    session.deviceCode = deviceCode; session.view.userCode = userCode;
    session.interval = Math.max(1, Math.min(60, number(data.interval) ?? 5));
    const lifetime = number(data.expires_in) ?? (codex ? 900 : 0); if (lifetime <= 0 || lifetime * 1000 > 2_147_483_647) schema();
    session.view.expiresAt = Date.now() + lifetime * 1000;
    clearTimeout(session.expiry); session.expiry = setTimeout(() => this.fail(session, new AppError('LOGIN_EXPIRED', 'Login session expired.')), session.view.expiresAt - Date.now()); session.expiry.unref();
    if (codex) session.view.verificationUri = 'https://auth.openai.com/codex/device';
    else {
      const verification = text(data.verification_uri_complete) ?? text(data.verification_uri) ?? text(data.verification_url); if (!verification) schema();
      let url: URL; try { url = new URL(verification); } catch { schema(); }
      if ((url.origin !== 'https://auth.x.ai' && url.origin !== 'https://accounts.x.ai') || url.username || url.password) schema();
      session.view.verificationUri = url.href;
    }
    this.queue(session);
  }
  private queue(session: Session): void {
    if (!this.active(session)) return;
    session.timer = setTimeout(() => { void this.poll(session).catch(error => this.fail(session, error)); }, Math.min(session.interval * 1000, Math.max(1, session.view.expiresAt - Date.now()))); session.timer.unref();
  }
  private async poll(session: Session): Promise<void> {
    if (!this.active(session)) return;
    const codex = session.view.provider === 'codex';
    const response = await request(codex ? 'https://auth.openai.com/api/accounts/deviceauth/token' : 'https://auth.x.ai/oauth2/token', codex ? json({ device_auth_id: session.deviceCode, user_code: session.view.userCode }) : form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: session.deviceCode!, client_id: GROK_CLIENT }), session.abort.signal);
    if (!this.active(session)) return;
    const error = text(response.data.error);
    if (error === 'expired_token') throw new AppError('LOGIN_EXPIRED', 'Device code expired.');
    if (error === 'access_denied') throw new AppError('LOGIN_DENIED', 'Login permission was denied.');
    if (error === 'slow_down' || response.status === 429) { session.interval = Math.max(session.interval + 5, response.retryAfter ?? 0); this.queue(session); return; }
    if (error === 'authorization_pending' || (codex && !error && [403, 404].includes(response.status))) { this.queue(session); return; }
    let data = expect(response, true);
    if (codex) {
      const code = text(data.authorization_code); const verifier = text(data.code_verifier); const challenge = text(data.code_challenge);
      if (!code || !verifier || !challenge || !equal(createHash('sha256').update(verifier).digest('base64url'), challenge)) schema();
      data = expect(await request('https://auth.openai.com/oauth/token', form({ grant_type: 'authorization_code', code, client_id: CODEX_CLIENT, redirect_uri: 'https://auth.openai.com/deviceauth/callback', code_verifier: verifier }), session.abort.signal), true);
    }
    await this.finish(session, tokens(data));
  }

  async complete(provider: ProviderId, loginId: string, input: string): Promise<LoginView> {
    const session = this.require(provider, loginId);
    if (session.view.mode === 'device') throw new AppError('LOGIN_MODE', 'Device login completes automatically.');
    if (typeof input !== 'string' || !input.trim() || input.length > 16_384) throw new AppError('LOGIN_INPUT', 'Paste the complete callback URL or code#state.');
    let query: URLSearchParams;
    const trimmed = input.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      let url: URL; try { url = new URL(trimmed); } catch { throw new AppError('LOGIN_INPUT', 'Invalid callback URL.'); }
      const redirect = new URL(session.redirect);
      if (url.origin !== redirect.origin || url.pathname !== redirect.pathname || url.username || url.password) throw new AppError('LOGIN_INPUT', 'The callback URL does not match this login.');
      query = url.searchParams;
    } else {
      // Claude's hosted callback displays code#state. A bare code cannot satisfy mandatory state validation.
      const [code, state, extra] = trimmed.split('#');
      if (!code || !state || extra !== undefined) throw new AppError('LOGIN_INPUT', 'Paste the callback URL or complete code#state, including state.');
      query = new URLSearchParams({ code, state });
    }
    await this.accept(session, query); return this.view(session);
  }
  async callback(provider: ProviderId, query: URLSearchParams): Promise<void> {
    if (this.context.cloud) throw new AppError('LOGIN_MODE', 'Server callbacks are disabled in cloud mode.', 404);
    const state = query.get('state');
    const session = state ? [...this.sessions.values()].find(item => item.view.provider === provider && item.view.mode === 'callback' && item.state && equal(item.state, state)) : undefined;
    if (!session) throw new AppError('LOGIN_STATE', 'Callback state did not match a login session.');
    await this.accept(session, query);
  }
  private async accept(session: Session, query: URLSearchParams): Promise<void> {
    if (!this.active(session)) throw new AppError('LOGIN_EXPIRED', 'Login session is no longer pending.');
    const state = query.get('state');
    if (query.getAll('state').length !== 1 || !state || !equal(session.state, state)) throw new AppError('LOGIN_STATE', 'Callback state did not match this login session.');
    if (session.busy) throw new AppError('LOGIN_INPUT', 'This login is already being completed.', 409);
    if (query.has('error')) { const error = new AppError('LOGIN_DENIED', 'Login permission was denied.'); this.fail(session, error); throw error; }
    const code = query.get('code'); if (!code || query.getAll('code').length !== 1) throw new AppError('LOGIN_INPUT', 'Callback did not contain one authorization code.');
    session.busy = true;
    try {
      const provider = session.view.provider;
      const body = { grant_type: 'authorization_code', code, redirect_uri: session.redirect, code_verifier: session.verifier };
      let data: ObjectValue;
      if (provider === 'claude') data = await claudeToken({ ...body, client_id: CLAUDE_CLIENT, state: session.state }, session.abort.signal);
      else {
        const endpoint = provider === 'codex' ? 'https://auth.openai.com/oauth/token' : provider === 'grok' ? 'https://auth.x.ai/oauth2/token' : 'https://oauth2.googleapis.com/token';
        const client = provider === 'codex' ? CODEX_CLIENT : provider === 'grok' ? GROK_CLIENT : GOOGLE_CLIENT;
        data = expect(await request(endpoint, form({ ...body, client_id: client, ...(provider === 'antigravity' ? { client_secret: GOOGLE_CLIENT_SECRET } : {}) }), session.abort.signal), true);
      }
      // Token response is obtained directly from the fixed TLS issuer; never accept caller-supplied ID tokens.
      if (provider === 'grok' && !equal(text(claims(data.id_token).nonce) ?? '', session.nonce)) throw new AppError('LOGIN_STATE', 'The provider nonce did not match this login.');
      const auth = tokens(data);
      if (!auth.refreshToken) schema();
      await this.finish(session, auth);
    } catch (error) { this.fail(session, error); throw error instanceof AppError ? error : new AppError('UPSTREAM_ERROR', 'Login could not be completed.', 502); }
  }
  private async finish(session: Session, auth: Auth): Promise<void> {
    if (!this.active(session)) throw new AppError('LOGIN_EXPIRED', 'Login session is no longer pending.');
    if (!auth.refreshToken) schema();
    await this.context.onAuth(session.view.accountId, auth);
    if (!this.active(session)) return;
    session.view.status = 'complete'; this.release(session);
  }
}
