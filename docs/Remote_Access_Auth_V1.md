# Remote Access Auth V1

Direct loopback access does not require a password. A fresh installation opens the application immediately on localhost, 127.0.0.1 or ::1, with no LoginPage or SetupPage. Local browsing does not create authenticated sessions.

Remote LAN, reverse-proxy and Cloudflare Tunnel access requires a Remote Access Password and a valid SQLite-backed session. A remote client cannot create the first password. Configure it locally in **Settings → Remote Access**. A tunnel will not start without it, including when `TUNNEL_ENABLED=true`; the local server remains available.

## Request classification

HTTP auth, auth status/routes and WebSocket upgrades use `security/request-access.ts`. The raw socket peer is authoritative. A request qualifies for direct loopback access only when all of these conditions hold:

- The peer is in 127.0.0.0/8, is ::1, or is an IPv4-mapped loopback address.
- No Forwarded, X-Forwarded-For/Host/Proto, X-Real-IP, CF-Connecting-IP, CF-Ray or CF-Visitor header is present, including empty headers.
- Host is localhost (optionally with a trailing dot), a valid 127.x.x.x address, or [::1], optionally with a port in 1–65535.
- Origin, when present, is an HTTP(S) loopback origin with a valid authority and no path or credentials.

Every uncertain case is remote. Public Host/Origin on a loopback socket, DNS rebinding shaped requests and tunnel headers cannot enable bypass. A loopback Host cannot override a LAN peer. Local Vite Origin on port 5173 remains supported; forwarded Vite requests are conservatively remote.

HTTP still preserves the execution-scoped internal capability router, MCP bearer authentication and public auth/health routes. `/mcp` retains its separate bearer guard. `DISABLE_AUTH=true` remains a technical/headless mode with a loopback bind and tunnels forbidden.

## Password and session lifecycle

`GET /api/auth/status` returns authenticated, authRequired, accessMode, passwordConfigured, remoteAccessReady, remoteAccessBlocked, passwordSetupAllowed and setupRequired (always false). Local authenticated=true describes trusted local access, not a fabricated session. Remote missing-password status selects a blocked page without a setup form.

`POST /api/auth/setup` is direct-loopback-only and returns 403 local_only remotely or 409 already_initialized once configured. Local settings require only new/confirmation fields. `PUT /api/auth/password` permits local rotation without the old password; remotely it verifies the session and current password. Passwords use scrypt; legacy AUTH_PASSWORD migrates to a hash and is erased from the process environment.

Rotation advances auth.password_changed_at monotonically and invalidates older remote sessions. The requesting remote password-change session is refreshed; local access is unaffected. Existing remote WebSockets close on rotation. Upgrades and every remote input message validate the session and configured hash. A one-second timer detects out-of-process password resets for idle connections. Local password rotation leaves a running tunnel in place.

Sessions remain persisted in SQLite. Cookies keep httpOnly and sameSite=strict; secure=auto marks HTTPS tunnel cookies Secure while permitting HTTP loopback/LAN login. Plain HTTP LAN password authentication does **not** encrypt network traffic. Use HTTPS for transport protection; configuring LAN TLS is outside this version's scope. Cloudflare's external tunnel endpoint uses HTTPS.

Authentication rate limits use the raw peer for direct non-loopback clients, so spoofed XFF/CF headers cannot change their bucket. Loopback proxies use a valid CF client IP, the rightmost valid XFF address, or a shared proxy bucket. IPv6 addresses use the library's subnet-safe key generator. Deploy trusted proxies on loopback and configure their forwarding headers consistently.

## Localized UX

Local UI hides logout and never enters LoginPage merely because an unrelated API returns 401. Remote UI keeps remember-me/logout. Settings summarize local access, configured-password state and tunnel state, without exposing credentials. A missing-password tunnel warning provides a button that opens the password settings.

Backend auth failures return stable language-neutral codes; translateAuthError maps them in the current EN/RU/KO locale and supplies a localized generic fallback. Login errors are stored as codes so changing language updates visible error text immediately. Recovery instructions direct users to local settings or the local aikombinat reset-password command. RU/KO disclaimers and remaining obvious English UI labels are translated.

Core locale tests enforce exact key/placeholder parity and detect identical English text with an explicit technical-key allowlist. See [smoke report](Remote_Access_Auth_V1_Smoke_Report.md) for observed tests and limitations.

## Origin policy

The existing production WebSocket Origin allowlist and Cloudflare quick-tunnel exception remain enforced before auth. Set `CORS_ORIGIN` to include the actual origin when using a nondefault localhost port, LAN address or custom domain; authenticated remote requests do not bypass Origin checks. The smoke fixture explicitly allows its two local test origins.
