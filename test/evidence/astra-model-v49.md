# Model-directed packed MDN search replay

The task completed: open MDN, use returned Search control, fill fetch, select the
returned Window fetch result, and read the resulting documentation. Each next action
was chosen interactively from the preceding public response. No direct DOM/network
reads, screenshot fallback, fixed sleeps or wait_for commands were used for the task.

Candidate v49 was extracted from artifacts/newton-browser-0.6.4.tgz, whose recorded
pack hash is43fc069dfc1f7e0f7cc194dccf432eb669feb00a66af14a4d6b742e0b05351fe.
Calls used its public handleMcpMessage entry with MCP2026-07-28 metadata. This excludes
stdio framing overhead. Seven calls including start/stop,4,900 returned text tokens
(o200k_base over complete JSON text blocks),1,393.808ms aggregate handler elapsed.
No catalog, image, reasoning or model-deliberation costs included.

- Search button e2 click completed with the Search combobox in feedback.
- Fill e45 with fetch completed with value postcondition met, feedback value fetch.
- Scoped observation of the previously returned Search results listbox returned
  eleven options, including Window fetch() method e49.
- Clicking e49 acknowledged; optional feedback returned stale_target during
  navigation. One subsequent document read recovered without retrying input.
- Document generation advanced2→3 and text began Window: fetch() method, with
  explanatory prose and destination-page links. This proves the requested task effect.
- Public stop returned closed, host.close completed, interactive Node process exited.

Remaining findings: broad initial observation still includes footer noise; successful
navigation produces unhelpful stale_target optional feedback; document read omitted
syntax/example code despite retaining surrounding headings and prose. A separate
post-task HTTP diagnostic confirmed server HTML contains pre/code examples. Reader
source handles ordinary PRE but only descends childNodes; live hydrated structure
still needs inspection before attributing the omission to a specific cause.

Automatic approval review rejected cleanup as blocked by policy, without further
reason. No alternative deletion attempted. Residual directories, both under this
worktree's test/evidence:
- astra-model-v49-package (extracted package)
- astra-model-v49-config (isolated QA configuration; no personal profile)

Raw calls/results/timing are in astra-model-v49.json. This is one model-directed
everyday task success, not full release acceptance or Chrome-control parity.
