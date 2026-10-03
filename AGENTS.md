# Gauge.js engineering instructions

Read `PLAN.md` (unaltered original specification), `README.md` and `SECURITY.md` before changing behavior. `CLAUDE.md` incorporates these rules. Preserve CNAME and Apache-2.0 LICENSE. Root `index.html` is the GitHub Pages introduction; `public/index.html` is the server dashboard. Never turn Pages into a hosted dashboard or publish credentials.

## Architecture and conventions

- TypeScript everywhere, ESM, Node >=22.13.0; native fetch, HTTP, crypto and SQLite. Runtime third-party dependencies are not permitted without an explicit architecture decision. TypeScript and Node types are development tools.
- Use strict types and validate untrusted JSON; no `any`, invented quota data, silent success fallbacks or production mocks. Keep provider response differences in `src/providers`; shared interfaces in `src/types.ts` are authoritative.
- Keep OAuth in `src/auth`, persistence in `src/store`, scheduler and notification policy separate from transport, RFC8291/VAPID in `src/push`, and browser code in `src/client`. Follow actual repository APIs rather than copying illustrative plan pseudocode.
- Web UI text belongs in matching `public/locales/{en,zh-TW,ja}.json` dictionaries; fallback zh-TW then en. Use Intl for dates, numbers and durations. Maintain all ten themes, semantic status colors, responsive layout and keyboard accessibility.
- Database changes require versioned schema migrations, prepared statements and transactional writes. Retain 200 samples per account. Never alter a production database manually.
- Poll per account with single-flight, jitter and bounded backoff. Persist rotated refresh tokens atomically before further use; do not read any CLI credential file.

## Security invariants

Local defaults to loopback; cloud requires PIN plus validated HTTPS origin and binds the platform port. Never disable cloud auth to fix deployment. Never expose tokens, PINs, VAPID private keys, auth state, PKCE verifiers or raw provider responses in APIs/logs. Apply safe errors and do not concatenate user input into SQL or HTML.

OAuth transactions must bind provider/account/state and expire; verify state for callback and pasted redirects. PKCE verifier remains in memory. Cloud uses device codes or paste completion, not public callback routes. Provider URLs are allowlisted; push endpoints need independent SSRF checks because browsers supply them. No arbitrary outbound URL proxy.

Service Worker caches only the static shell, never authenticated API responses. Database, WAL/SHM and backups are sensitive and excluded from Git. See SECURITY.md for detailed policy.

## Change and verification workflow

Inspect relevant code and existing patterns first. Prefer minimal complete changes; migrate all callers rather than leave compatibility shims or TODO scaffolds. Preserve user changes. Update tests and README/CHANGELOG when behavior changes. Do not commit, push, deploy or publish without explicit authorization.

Run appropriate build/tests after integration, not while parallel edits are unfinished. Record commands and actual outcomes; never claim an unexecuted check passed. Add permanent regression cases for fixed bugs. RFC 8291 Appendix A is a mandatory push cryptography regression. Live OAuth, two refresh cycles, real device pushes, Replit login, 24-hour monitoring, accessibility and deployment checks require manual gates; unit tests are not substitutes. Gate evidence must not include secrets.
