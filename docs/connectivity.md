# Connectivity

## Share Fitz (clientless recipients)

Share Fitz is the supported path for a girlfriend, friend, or API consumer who should not have to
install Tailscale. The desktop keeps the restricted gateway on port 8790 available while the local
app is running. It can be published either with Tailscale Funnel or with the packaged,
checksum-pinned `cloudflared` connector. For Cloudflare, the tunnel token is encrypted with Electron
`safeStorage`, passed through `TUNNEL_TOKEN` rather than process arguments, and forgotten when the
administrator selects **Turn off and forget token**.

Cloudflare's published hostname must target `http://127.0.0.1:8790`, never the host port. Port 8790
is a loopback-only, fail-closed gateway with a method-aware consumer allowlist, independent rate and
concurrency bounds, an 8 MiB request limit, minimal unauthenticated health, and consumer-role
verification against the host on every request. It does not proxy management, bootstrap, global
events, connections, model configuration, host-path project creation, or private pairing. Public
pairing uses `/api/v1/pairing/redeem-shared`, which consumes only one-use consumer codes. Consumer
agent runs are additionally barred from executing any host tool.

The recipient selects **Use remote host** in the desktop, enters the public HTTPS origin, and then
enters the one-use code. Remote HTTP and URL credentials/paths/query strings are rejected. A failed
remote connection never starts a bundled local host as a fallback.

Tailscale Funnel can publish the gateway without requiring Tailscale on recipient devices:

```powershell
tailscale funnel --bg --yes http://127.0.0.1:8790
```

Funnel must never target the privileged Fitz host port 8787.

## Optional private Tailscale access

`GET /api/v1/management/connectivity/status` reports normalized Tailscale availability, backend state, MagicDNS
name, and tailnet addresses. An administrator can opt in to private HTTPS proxying through the
Tailscale Serve management endpoint. Fitz invokes the current Serve form with a loopback-only target:

```text
tailscale serve --https=443 --bg --yes http://127.0.0.1:8787
```

Disabling Fitz's HTTPS listener uses `tailscale serve --https=443 off`, avoiding a blanket reset of
unrelated Serve configuration. The commands are only run after an explicit authenticated administrator request;
startup and status checks do not modify networking. See the current
[Tailscale Serve CLI documentation](https://tailscale.com/docs/reference/tailscale-cli/serve).

The desktop keeps the last native event sequence and retries transient bridge/network failures with
jittered exponential backoff, capped at 15 seconds and 12 consecutive attempts. Successful replay
continues from the last received sequence rather than duplicating visible output.

Tailscale is optional and remains externally installed. It is useful for the owner's private devices;
it is not required for Share Fitz recipients.
