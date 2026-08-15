# Connectivity

## One Hosting workflow

The host administrator uses **Hosting**. The Overview tab has one switch: **Allow remote access**.
Enabling it starts the loopback-only consumer gateway on `127.0.0.1:8790` and publishes exactly that
gateway with Tailscale Funnel. Disabling it removes only Fitz's configured Funnel listener; it does
not reset unrelated Tailscale configuration.

```text
tailscale funnel --https=443 --bg --yes http://127.0.0.1:8790
tailscale funnel --https=443 http://127.0.0.1:8790 off
```

Funnel must never target the privileged Fitz host on port 8787. The gateway requires a bearer API
key on every request (including health), rejects administrator and agent credentials, and exposes a narrow,
method-aware allowlist. Administration, provider connections, model configuration, local bootstrap,
pairing, global events, and host-path project creation are absent. It also applies bounded request
size, per-key and global request rates, authentication concurrency, request concurrency, minimal
health responses, defensive headers, and immediate credential revalidation.

The owner PC needs the installed Tailscale daemon, a signed-in account, and Funnel permission for
the tailnet. Recipients do not install Tailscale and do not join the tailnet: they install Fitz and
enter only the public HTTPS URL plus their API key. Normal operation—including enabling/disabling
hosting, users, keys, startup, status, diagnostics, and configuration—is controlled inside Fitz.

The Users tab creates a consumer account and named API key together. The raw key is displayed once.
Keys can be rotated or revoked, and removing a user disables the account and revokes all active keys
while preserving audit and usage history.

The desktop keeps the last native event sequence and retries transient bridge/network failures with
jittered exponential backoff, capped at 15 seconds and 12 consecutive attempts. Successful replay
continues from the last received sequence rather than duplicating visible output.

Current CLI behavior is documented by Tailscale at
[Tailscale Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel).
