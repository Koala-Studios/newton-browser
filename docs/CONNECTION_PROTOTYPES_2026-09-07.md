# Connection and login-source feasibility

Status: disposable experiments on Windows, 2026-09-07. The operator authorized these
before the full replacement build. Production source remains the audited 0.6.4 runtime.
The accepted product decisions are incorporated in [the design](SESSION_ENGINE_DESIGN.md)
and [AGENTS.md](../AGENTS.md). No extension was installed into the operator's browser.

## Decisions now fixed

- Default to standalone, using a shared Newton-owned login source. Every worker gets
  its own headless browser process and writable identity.
- "My browser" or "my current profile" explicitly selects the existing browser. The
  model cannot choose that backend merely because it seems more convenient.
- Different workers may modify separate owned tabs concurrently through the extension.
  Tab ownership is enforced across connections; there is no profile-wide mutation lock.
- Newton adds no permission prompts or approval engine. Conflicting ownership is an
  actionable conflict, not an invitation to ask for permission again.
- The first replacement release means the completed architecture and audited fixes,
  tested and QA'd on real everyday online tasks. These prototypes are not that release.

## Results

| Experiment | Result | Practical implication |
| --- | --- | --- |
| Installed Chrome 152.0.7977.82, opaque login-source copies | Passed | Two separate headless processes inherited a fixture application's persistent login |
| Installed Edge 152.0.4191.66, same test | Passed | The same starting-login approach worked with the installed Edge build |
| Independent worker input and local logout | Passed | Workers edited independently; local logout in one copy left the other copy and source signed in |
| New worker while other workers remain active | Passed | A closed source can supply another isolated worker without closing running workers |
| Reusing one writable identity concurrently | Rejected by the existing identity lease | Shared starting login cannot mean a shared writable data directory |
| Real extension API, Chromium 151.0.7922.34, headless and headed | Passed | Separate tab claims, concurrent native input, AX trees, screenshots, and detach without closing tabs |
| Public Wikipedia page through the extension | Passed | Ordinary online navigation and semantic content read work through the adapter primitives |
| Chrome-launched Native Messaging executable and private Windows named pipe | Passed in headed and headless runs | Hello, tab CDP, and screenshot round trips require no HTTP relay or TCP control endpoint |
| Changed extension code followed by self-reload | Passed with developer mode enabled | The same installed extension reports a new boot epoch and rejects its old claim; no reinstall required |

The copied files remained opaque. The fixture application issued and validated its own
synthetic HTTP-only persistent cookie through normal browser networking. The harness
checked visible signed-in/signed-out page state, never browser cookie or storage values.
No personal login source or actual account credentials were used.

Timings in the JSON are diagnostic, not performance promises. They varied under concurrent
probe load: the final two-copy measurements were 134/151 ms, process startup was roughly
0.6–0.8 seconds per worker, and the final tab input measurements were 18 ms headless and
358 ms headed. Earlier uncontented headed runs were around 18 ms. These single-machine
measurements exclude model reasoning and are not comparable to full task latency; proper
task benchmarks need controlled conditions and latency distributions.

## Problems the probes exposed

**The current closure verifier is incompatible with an always-available shared source.**
It rejects the source when any process from that browser family exists, even if the
source itself is closed. The first Chrome run failed with
`profile_source_closure_unproved`. The passing probe instead bound the source to its sole
fixture launcher, successful guardian cleanup and available exact identity lease. The
final probe also deterministically demonstrates the legacy rejection while workers run.
Production needs a durable source-generation owner and crash reconciliation, not a
blanket verifier bypass or a requirement to close every browser.

**A tab-created acknowledgement is not document readiness.** The first extension probe
tried resolving a node while the initial navigation replaced its document and received
`Could not find node with given id`. The corrected harness creates blank tabs, subscribes
to lifecycle events, then waits for the specific navigation loader before inspecting the
fixture. No sleep or widened timeout was used. The engine needs this same distinction
between dispatch acknowledgement and the exact readiness condition an operation needs.

**Reload acknowledgement is not a working connection.** An initial test-browser setup
without the ordinary developer-mode setting acknowledged reload but did not restore a
usable extension. Waiting for an assumed service-worker target event stalled; navigating
to the extension page returned `ERR_BLOCKED_BY_CLIENT`. Enabling developer mode through
Chrome's own UI produced a working same-install self-reload in subsequent runs. The
acceptance oracle is a fresh handshake and rejection of stale claims, not acknowledgement
of `runtime.reload()` or one incidental DevTools event. The production updater still needs
quiescence, boot reconnection, packaged build identity, rollback and broken-bootstrap tests.

## What this does not prove

- Universal authentication portability. Real providers may rotate or revoke shared
  credentials, bind sessions to a device, or rely on state excluded from opaque copying.
  Local file isolation does not isolate server-side account effects.
- A finished login-source generation/publish/refresh mechanism. The test uses a private
  fixture source with one known launcher, not a durable production source manager.
- Full extension capability parity: nested cross-origin frames, popups, native dialogs,
  focus changes by a human, restricted pages, host loss, cancellation, and crash recovery
  still need shared-engine conformance and real-task tests.
- A production IPC implementation. The native host is a small disposable .NET byte
  forwarder, not a new product runtime dependency. The probe has bounded response framing
  but does not establish production ACLs, peer identity, chunk/backpressure behavior,
  fairness, multi-engine reconnection, or hostile-input robustness.
  The extension concurrency probe uses two logical worker claims driven by one harness;
  it does not yet integrate two independent MCP engine processes.
- A production updater. This tests a quiescent valid-code self-reload, not busy updates,
  manifest failure, rollback, native-host replacement, or store distribution.
- Model efficiency or completion of the audit fixes. These tests exercise primitives;
  the session owner, receipt semantics, reader, queue/deadline changes and model task
  benchmarks still need implementation. A public homepage read is very limited online
  evidence and cannot stand in for everyday interactive and authenticated workflows.

There are no further product-choice questions blocking the design. The remaining items
are implementation and empirical validation work, not reasons to add another approval
flow or ask the operator to design the internals.

## Reproduction and artifacts

Run from the repository root with Node 24+ and the normal built runtime prerequisites:

```powershell
pnpm prototype:login
$env:NEWTON_BROWSER_QA_BROWSER='edge'
pnpm prototype:login

# Point at an existing extension-test-capable Chromium executable.
$env:NEWTON_BROWSER_PROTOTYPE_EXECUTABLE='<absolute test Chromium executable>'
pnpm prototype:connection
$env:NEWTON_BROWSER_PROTOTYPE_HEADED='1'
pnpm prototype:connection
```

The connection probe currently requires Windows and .NET SDK 10 to compile its disposable
Native Messaging host. It uses development-only extension switches in an isolated test
profile, enables developer mode through that profile's own UI, registers a uniquely named
temporary native host, then removes the registration and owned test files. Nothing is
added to the production launch switches or package dependencies. Use the headed option
when a brief visible disposable browser is appropriate.

- [Chrome login evidence](../test/evidence/prototype-login-source-2026-09-07-chrome.json)
- [Edge login evidence](../test/evidence/prototype-login-source-2026-09-07-edge.json)
- [Headless connection evidence](../test/evidence/prototype-tab-connection-2026-09-07.json)
- [Headed connection evidence](../test/evidence/prototype-tab-connection-2026-09-07-headed.json)
- [Login probe](../scripts/prototype-login-source.mjs)
- [Connection probe](../scripts/prototype-tab-connection.mjs)

All listed final runs confirm cleanup. Evidence files are overwritten when rerunning a
probe; the failed experiments and corrections above preserve the material findings.

Chrome's documented [debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger),
[Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging),
[runtime reload](https://developer.chrome.com/docs/extensions/reference/api/runtime#method-reload),
and [development setup](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world)
support the approach. The results above are local observations, not promises that every
Chrome version, site, update failure or account behaves identically.
