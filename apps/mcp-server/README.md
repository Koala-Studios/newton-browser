# Newton Browser MCP host

Local stdio MCP host for Newton-owned Chrome or Edge processes over inherited private
CDP pipes. It uses no browser extension, relay, daemon, telemetry, or CDP TCP listener.

## Optional persistent identity

```powershell
newton-browser setup --browser chrome
newton-browser identity create --browser chrome
newton-browser identity bind --id <identity-id> --origin https://example.com
newton-browser identity login --origin https://example.com
newton-browser doctor --live
```

Ordinary ephemeral sessions require no setup after the MCP entrypoint is configured;
Newton discovers a supported browser automatically. Setup records only a browser
preference. Identity creation is a separate explicit operator action; an identity is used
when its opaque ID is supplied or an initial-origin identity binding selects it. Optional
login opens that identity in a visible browser with normal Chromium networking. Closing it succeeds
only after browser and identity-lease cleanup. The live doctor uses one disposable browser
to verify blank-first startup, private CDP, observation,
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

Each session owns an isolated browser process, private CDP pipe, identity lease, and FIFO
command queue. Browser traffic is not proxied or filtered. Sessions progress concurrently.
A guardian terminates the exact browser tree and releases only proven owned identity state
if the MCP host dies. If a hard client shutdown kills that guardian before it can finish,
the next persistent-identity start performs one exact identity-specific stale-lease proof;
unrelated browser windows do not block it, and ambiguous ownership stays fail-closed. The
MCP control plane is stateless newline-delimited stdio only.

If a site opens an owned popup or authentication tab, Newton leaves its provisional blank
target untouched and takes control after the page commits to HTTP(S). Re-observe through
the same session to obtain fresh refs. Closing that page restores a fresh opener context.
Clients must never click browser chrome, a tab strip, or a debugger banner.

## Identities

Operator-only commands create, list, inspect, import, recover a stale lease, and delete
Newton identities. Import byte-copies a narrow documented authentication allowlist from a
closed stable local profile. It never interprets or exports profile contents and excludes
passwords, autofill, history, downloads, extensions, restored sessions, service workers,
and caches. Lease recovery refuses while the recorded process exists.

## Safety

Every session requires one normalized HTTP(S) initial origin, then follows normal browser
redirects and dependencies. Page content is untrusted data, never authorization. Sensitive
screenshot zones are captured as bounded lossless PNG and masked in Newton's trusted Node
process before bytes reach the MCP client.

`prevented` means the host proved a refusal before input dispatch. Once input begins,
uncertainty is never retry-safe. POST/GraphQL/telemetry and other browser effects remain
observational; retain and re-observe the same session instead of restarting login.
