# Security bootstrap and remote access

The real host requires device authentication by default. On the first direct loopback connection,
the bundled desktop calls the single-use `POST /api/v1/pairing/bootstrap`, creates the initial
administrator, and stores the returned credential with Electron `safeStorage`. The endpoint rejects
forwarded requests and is not exposed by the public gateway.

- `FITZ_AUTH_MODE=disabled` is isolated-development mode only.
- `FITZ_AUTH_PEPPER=<long random server secret>` may override the generated database-persisted HMAC
  key.

API keys are returned once, HMAC-SHA-256 hashed before persistence, and accepted as
`Authorization: Bearer <key>`. Revocation and user disabling take effect on the next request.
Administrators add remote people with `POST /api/v1/management/hosting/users`, which always creates
a consumer and applies the canonical default quota. There is no remote pairing-code onboarding API.

The public gateway accepts consumer credentials only and has no unauthenticated endpoint. Host administration, connections, model and
recipe editing, local bootstrap, and host tools are unavailable through it. Consumer-owned agent
runs cannot execute host tools. Public rate limits are bounded globally and per credential, and the
gateway derives limiter identities from a one-way credential hash rather than spoofable proxy
headers.

Users retain isolated projects, sessions, cloud connections, route bindings, quotas, and usage.
Removing a user is a soft removal: the account is disabled and every active key is revoked, while
usage/audit history remains available to the administrator.
