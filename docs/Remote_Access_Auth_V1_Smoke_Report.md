# Remote Access Auth V1 Smoke Report

Date: 2026-10-01 (Asia/Yekaterinburg). Baseline: 586ed773b64dd4bc8f782d7ee7545ad632ea6978, main.

## Disposable browser fixture

Used a new empty SQLite database under an ignored node_modules/.remote-auth-smoke-* directory, a production Node server on localhost:39871 with BIND_HOST=0.0.0.0, and a loopback proxy on localhost:39872. The proxy adds X-Forwarded-For, X-Forwarded-Proto and CF-Ray to both HTTP and WS requests. CORS_ORIGIN explicitly includes the two test origins. No production DB or project was used, and no task execution was launched. Ordinary startup model discovery ran against the disposable configuration. Fixture credentials were test-only.

| Scenario | Observed result |
| --- | --- |
| Fresh direct localhost, empty DB, no cookie | Main project page immediately; no login or setup page; local logout hidden |
| TUNNEL_ENABLED=true, missing password | Startup logs tunnel.blocked; local HTTP server remains alive; no tunnel URL starts |
| BIND_HOST=0.0.0.0, missing password | Local UI works; startup warns that remote API/WS access is blocked |
| Proxy-shaped browser, missing password | Russian blocked page, with local configuration instructions; no setup form or password input |
| Tunnel Settings, missing password | Russian password warning and CTA; Start disabled |
| Tunnel password CTA | Opens local password settings, with new/confirmation only and no current-password field |
| Local fixture password configuration | POST /api/auth/setup returns 200; local browsing still needs no login |
| Russian remote login | Remote Access wording, translated disclaimer, remember-me checkbox |
| Russian forgot-password expansion | Fully translated prose; directs to local Settings → Remote Access or local reset-password command |
| Russian remote login with fixture credential | Main app opens; remote logout visible |
| Remote browser WebSocket | DOM connection indicator has title «Подключено» and bg-status-success |

## Automated security matrix

Tests call the real middleware and routes, use real SQLite sessions and actual HTTP/WS connections. Tunnel-manager process launches are mocked.

| Boundary | Result |
| --- | --- |
| 127.0.0.1, 127.0.0.2, 127/8, ::1, mapped IPv4 loopback | Direct local |
| Real IPv6 ::1 HTTP/WS sockets | API 200, WS connects, no password |
| Raw LAN/private/public peer with localhost Host | Remote; no bypass |
| Any specified forwarding or Cloudflare header, including empty | Remote |
| Public/malformed Host or Origin, rebinding shapes | Remote |
| Loopback Vite Origin on 5173 | Local |
| Local API without/with a password | Allowed without session |
| Remote without configured password, even with old authenticated state | HTTP/WS denied |
| Remote setup on empty hash | 403 local_only; no hash saved |
| Local setup with valid new/confirmation | Hash saved, no authenticated cookie/session created |
| Local password change without old password | Allowed; local access unaffected |
| Remote change without session/current password/wrong current password | Stable localized-error codes; denied |
| Valid remote login/session | HTTP and WS allowed |
| Local rotation | Older remote HTTP/session status/WS upgrade denied; connected remote WS closes with 1008 |
| Hash removal while a session exists | HTTP and WS upgrades denied independently of tunnel state |
| HTTPS forwarding for remote login | Secure, HttpOnly, SameSite=Strict cookie |
| HTTP loopback login | Cookie works without forcing HTTPS |
| Direct LAN XFF/CF spoofing | Raw-peer rate-limit key unchanged |
| Proxy limiter | Rightmost valid XFF or valid CF IP; malformed input uses shared bucket; 429 too_many_auth_attempts |
| Manual quick/named tunnel with no password | 409 remote_password_required; neither manager start method called |
| Configured quick/named tunnel | Correct manager method called |
| Production forbidden WS Origin | 403 before auth; existing Origin policy remains enforced |
| MCP bearer | Correct bearer retained independently of local access; wrong bearer rejected |
| Existing headless/plugin, sessions, campaigns/consensus | Full server regression suite passes |

## i18n and validation

RU/KO render tests cover login, disclaimer, forgot-password instructions, backend error translation, blocked page and password settings. A language-switch test changes an already displayed English error to Russian immediately. Local unauthorized-event tests retain passwordless local access. Tunnel CTA tests verify disabled start and opening the password panel.

EN/RU/KO key and placeholder parity passes. Exact-English audit passes with an explicit technical-key allowlist and no wildcard namespaces. The listed Russian remnants and additional Korean English labels were translated.

- npm run typecheck: passed.
- npm test: passed; server 2549 passed, 2 existing skips across 84 files; client 220 passed across 39 files.
- npm run build: passed after using permission to overwrite pre-existing generated dist files; final rerun after copy changes also passed.
- npm run docs:erd:check: passed, ERD unchanged.
- git diff --check: passed.
- Final pushed GitHub CI is reported in the completion response; this report does not claim a pre-push CI result.

The installed better-sqlite3 binary initially targeted Electron ABI 148. It was rebuilt for Node 22 ABI 127 for testing, then rebuilt for Electron after validation. The first backup was removed by the rebuild tool; no production application data was affected. Existing client bundle-size/Browserslist warnings and jsdom canvas messages are unrelated to this change.

## Limitations

The Internet-facing Cloudflare service was not exposed in this run. Proxy-shaped browser traffic and mocked quick/named starts provide tunnel security evidence; a live public tunnel login is not claimed. LAN peers are covered by raw-socket classifier/middleware tests, while the browser fixture uses a loopback proxy. Production custom domains, LAN and nondefault localhost ports require their origin in CORS_ORIGIN under the preserved WS Origin policy. Out-of-process password reset disconnects idle remote WS clients within the one-second revalidation interval; input and new upgrades validate immediately. HTTP LAN has no transport encryption.

Result: READY_WITH_LIMITATIONS, subject to final pushed CI verification.
