# Security bootstrap

Authentication is disabled for the local fake-engine development flow. Enable the production
authentication boundary with these environment variables:

- `FITZ_AUTH_MODE=required`
- `FITZ_AUTH_PEPPER=<long random server secret>`
- `FITZ_BOOTSTRAP_ADMIN_TOKEN=<initial bearer token>` (required only while the database has no users)

The bootstrap token is HMAC-SHA-256 hashed before persistence and is never returned by the API.
After bootstrapping, use it as `Authorization: Bearer <token>` to create users and issue device
tokens through `/api/v1/management`. Device tokens are shown once when issued; only keyed hashes
are stored. Revocation takes effect on the next request.

Administrators can access every inference route. Agent and consumer users only see and use routes
listed in their explicit route grants. Their role default or custom quota limits request rate,
prompt size, output tokens, and queue depth.

`FITZ_ADMIN_TOKEN` remains a development-only compatibility guard when required authentication is
disabled.
