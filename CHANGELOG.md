# Changelog

## Unreleased

- Initial Gauge.js implementation: TypeScript/ESM Node service, SQLite persistence, per-account scheduling, four-provider OAuth and quota integrations, and native VAPID/Web Push.
- PWA dashboard with multi-account controls, trends, ten themes and English / Traditional Chinese / Japanese dictionaries.
- Added local/cloud deployment configuration, backup export and security policy; retained the original plan verbatim in PLAN.md.
- Added root GitHub Pages introduction, separate from the authenticated Node dashboard; existing CNAME and LICENSE remain unchanged.
- Prevent stale refresh/quota results from overwriting a newly authorized account; enforce Retry-After and the backoff ceiling after jitter.
- Honor device-code lifetimes and accept Grok's official accounts.x.ai verification portal without permitting unrelated origins.
- Distinguish provider authorization errors from dashboard PIN errors, keep CSP free of unsafe-inline, and improve Moonstone text/status contrast.

Recorded local verification: successful build, 32 passing tests on Node 22.13.1, actual desktop Edge dashboard/offline checks, official Codex/Grok device-code initiation, and delivered test/low/recovered Web Push with cooldown deduplication. UI/quota-transition smoke used an isolated synthetic database; it is not evidence of live provider quotas.

Live four-provider authorization and quota reads, two refresh cycles each, Replit deployment, target mobile-platform push/install checks, 24-hour monitoring, a complete accessibility audit, deployment restore drills and Pages publication remain manual acceptance items. No production deployment or complete gate acceptance is declared.
