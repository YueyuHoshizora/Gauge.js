# Security policy

## Scope and supported configuration

Gauge.js is a self-hosted, single-owner subscription-quota monitor, not a multi-tenant service, API proxy or account-sharing system. Use the current maintained revision and Node.js >=22.13.0 with security updates. Older Node versions and deployments with disabled authentication, untrusted proxies, or exposed data directories are unsupported. No security audit, successful deployment or completed acceptance gate is asserted by this document.

## Reporting vulnerabilities

Do not post credentials, database files, authorization URLs/codes, push subscription secrets or exploit details in public issues. Use the repository's GitHub **Report a vulnerability** / private security advisory feature if enabled. If it is unavailable, use a maintainer contact channel listed on the repository/profile and ask for a private reporting channel before sending sensitive details. No dedicated security email or response-time guarantee is currently designated. Report affected revision/runtime, deployment mode, impact and a minimal redacted reproduction. Coordinate disclosure until a mitigation is available; do not test systems or accounts without permission.

## Trust boundaries and access control

The owner controls the host, reverse proxy, environment, database, backups and dependency installation. Anyone with shell access or the shared PIN can access all managed accounts. The PIN is not account isolation, password-based encryption or a substitute for a secure host.

Local service defaults to 127.0.0.1. Cloud binds 0.0.0.0 on the platform port and must require a PIN of at least eight characters; choose a much longer random secret. Authenticated API access uses an Authorization bearer value. Never include the PIN in a URL or return it through settings/status. Browser unlock material belongs only in sessionStorage and can still be exposed by XSS or compromised extensions. Lock/reload behavior is not server-side token revocation; rotate the PIN in deployment secrets and restart to revoke the old value.

Cloud requires a validated HTTPS origin, explicitly configured or derived from an approved Replit development domain. Reverse proxies must terminate valid TLS, use the intended origin and not expose the internal listener. Reject unexpected origins rather than enabling wildcard CORS. Origin checks complement bearer authentication; they do not authenticate non-browser clients. Public static assets must contain no account or credential data.

## OAuth and provider access

All credentials originate from web-initiated OAuth. Never read a local CLI credential store. Authorization transactions are short-lived, in-memory and bound to a provider/account. Verify OAuth state on callbacks and pasted redirect URLs; use PKCE S256 where applicable and nonce where required. Drop verifier/state material on success, cancellation, expiry and shutdown. Restarting interrupts pending login transactions.

Device-code polling must honor expiry, pending, denial and slowdown. Loopback callbacks are local-only and ephemeral when a dedicated port is needed. Cloud uses device codes or pasted authorization results; a loopback URL points to the browser's device, not a hosted server. Never remove state verification to accommodate a provider's code display page; unsupported response formats must fail visibly and require manual verification.

Access and refresh tokens stay server-side. Refresh rotation must be committed atomically before subsequent requests. Never emit tokens, auth objects, raw sensitive provider responses or authorization headers in API projections, logs or error messages. Published installed-application client IDs/secrets are public protocol metadata, not permission to expose user tokens. Provider endpoint availability, account eligibility and terms may change; failures must not become fabricated quota data.

Provider requests use fixed official destinations. Do not accept arbitrary provider base URLs from API parameters. Redirect handling must not bypass destination restrictions. Keep request timeouts and safe errors; do not dump upstream bodies into the UI.

## Web Push and SSRF

Push subscription endpoints and key material are untrusted. Validate HTTPS URLs, recognized push-service destinations, ports, credentials, address classes and redirects before outbound requests. Block loopback, private, link-local, multicast and cloud metadata destinations; allowlisting and DNS/address checks must not be bypassed by alternate URL spelling or redirection. Push destinations are a separate restricted boundary from OAuth/provider domains.

The implemented push endpoint allowlist is `fcm.googleapis.com`, one-label `*.push.services.mozilla.com`, one-label `*.push.apple.com`, and one-label `*.notify.windows.com`. Only HTTPS port 443 is accepted; credentials, fragments and redirects are rejected. All resolved addresses must be public and the connection is pinned to a validated address. JSON payloads are limited to 3993 bytes. Other push services require a reviewed explicit code change, not an arbitrary operator-provided endpoint exception.

Use VAPID ES256 and RFC 8291 aes128gcm with secure randomness and TTL 3600. Keep the private key server-side and subscriptions protected. Retire expired subscriptions. RFC 8291 Appendix A is required regression coverage, but a vector test alone does not certify the complete implementation. Push delivery is not guaranteed; do not use this app as an emergency alert service.

## Persistence, backup and restore

SQLite stores reusable credentials in plaintext at the application layer. Permissions (database 0600 and restricted parent directory, WAL/SHM and snapshots) do not protect against a compromised owner/root account; use encrypted disks and encrypted external backups as appropriate. Apply prepared statements and versioned schema migrations. Do not edit production schema manually or copy only a live WAL database's main file.

Create consistent snapshots with the SQLite backup API or VACUUM INTO on runtimes without the native backup API. Startup snapshots on the same ephemeral disk do not constitute off-site recovery. Exclude databases, backups, environment secrets and build artifacts from Git. Replit persistence and sleep behavior depend on the selected product/plan; verify them rather than assuming always-on operation or durable disks.

Restore only while all writers are stopped. Preserve the old directory for rollback, replace the database with a compatible snapshot, avoid stale WAL/SHM files, restore restricted permissions and environment secrets, then check account access and push keys. Old snapshots may contain revoked refresh tokens; reauthentication may be required. Changed VAPID keys require device resubscription. See README for operator steps and export command.

## Browser and offline security

Render untrusted labels and messages as text, not HTML. Keep UI assets and dictionary lookups separate from account data. Service Worker caches only the static app shell; never cache API responses, bearer headers, OAuth codes or tokens. Offline UI is not current quota state. HTTPS or localhost is required for Service Workers and Push; plain LAN HTTP is not secure context. Browser extensions, malicious scripts and an unlocked shared device remain threats.

## Incident response

Stop external access and preserve redacted diagnostic evidence. Rotate the PIN, revoke provider grants/tokens through each provider, rotate VAPID keys if exposed and re-enroll subscriptions. Review host/proxy access, repository history and backup copies. Rebuild a compromised host from trusted inputs rather than merely changing a PIN. Restore only a known-good snapshot, assess whether refresh-token rotation invalidates it, and notify affected users where required. Deleting a leaked file from the current Git tree does not remove it from history or revoke credentials.

## Verification and limitations

Maintain automated tests for authorization/origin rejection, API redaction, state/PKCE ownership, parser errors, scheduler/backoff, database snapshots and push vectors. Separately execute the plan's manual gates: four live providers, two refresh cycles, cloud device/paste login, real device delivery, low/recovered deduplication, 24-hour operation, accessibility, restore drills and actual deployment. No automated test substitutes for these gates; document only observed outcomes without secrets.
