# Security bootstrap

The real host requires device authentication by default. On the first direct loopback connection,
the Fitz desktop calls `POST /api/v1/pairing/bootstrap`, creates the sole initial administrator, and
stores the returned device credential with Electron `safeStorage`. The endpoint is single-use and
rejects forwarded requests, so it cannot be used through the private HTTPS proxy.

- `FITZ_AUTH_MODE=disabled` explicitly disables authentication for isolated development only.
- `FITZ_AUTH_PEPPER=<long random server secret>` optionally overrides the randomly generated,
  database-persisted host secret.

Device tokens are returned once, HMAC-SHA-256 hashed before persistence, and never exposed to the
desktop renderer. Use `Authorization: Bearer <token>` for direct API access. Revocation takes effect
on the next request.

Administrators can access every inference route. Agent and consumer users only see and use routes
listed in their explicit route grants. Their role default or custom quota limits request rate,
prompt size, output tokens, and queue depth.

`FITZ_ADMIN_TOKEN` remains a development-only compatibility guard when authentication is explicitly
disabled. Fitz refuses to enable Tailscale Serve in this mode.

Administrators can issue short-lived, one-use pairing codes through
`POST /api/v1/management/pairing-codes`. A new client redeems the code without prior authentication
at `POST /api/v1/pairing/redeem` and receives its device token once. Only the keyed code and token
hashes are stored. Reusing or redeeming an expired code fails, and device revocation applies on the
next authenticated request.
