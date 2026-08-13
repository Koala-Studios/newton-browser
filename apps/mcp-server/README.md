# Newton Browser MCP host

Local stdio MCP host for Newton-owned Chrome or Edge processes over inherited private
CDP pipes. It uses no browser extension, relay, daemon, telemetry, or CDP TCP listener.

## Optional persistent identity

```powershell
newton-browser setup --browser chrome
newton-browser identity create --browser chrome
newton-browser identity login <identity-id> --origin https://example.com
newton-browser doctor --live
```

Ordinary ephemeral sessions require no setup after the MCP entrypoint is configured;
Newton discovers a supported browser automatically. Setup records only a browser
preference. Identity creation is a separate explicit operator action; an identity is
used only when its opaque ID is supplied to session start. Optional login opens that
identity in a visible browser restricted
to the exact origin and explicit `--allow-origin` values;
closing it succeeds only after browser, proxy, and identity-lease cleanup. The live doctor
uses one disposable browser to verify blank-first containment, private CDP, observation,
shutdown, and cleanup. Ordinary `doctor` is configuration-only.

## MCP client

```json
{
  "mcpServers": {
    "newton-browser": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["C:\\absolute\\path\\newton-browser\\apps\\mcp-server\\dist\\index.js"]
    }
  }
}
```

Each session owns an isolated browser process, launch-time exact-origin policy proxy,
private CDP pipe, identity lease, and FIFO command queue. Sessions progress concurrently.
A guardian terminates the exact browser tree and releases only proven owned identity state
if the MCP host dies. The MCP control plane is stateless newline-delimited stdio only.

## Identities

Operator-only commands create, list, inspect, import, recover a stale lease, and delete
Newton identities. Import byte-copies a narrow documented authentication allowlist from a
closed stable local profile. It never interprets or exports profile contents and excludes
passwords, autofill, history, downloads, extensions, restored sessions, service workers,
and caches. Lease recovery refuses while the recorded process exists.

## Safety

Every session requires one normalized HTTP(S) origin plus explicit grants. Proxy and driver
containment are active before the first navigation. Page content is untrusted data, never
authorization. Sensitive screenshot zones are captured as bounded lossless PNG and masked
in Newton's trusted Node process before bytes reach the MCP client.
