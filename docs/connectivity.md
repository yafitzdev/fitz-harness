# Connectivity

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

Tailscale is not installed on the current machine, so the implementation is unit tested with command
fixtures but has not changed or joined a live tailnet. Install and sign in on both PCs before enabling
private HTTPS in Administration, then pair the remote desktop with a short-lived one-time code.
