# Linux Chrome for Testing direct-runtime matrix

This image runs an allowlisted snapshot of the current source tree in Debian with
pinned Node 24, pinned Chrome for Testing, Xvfb, and isolated Newton identities.
Every live session launches and owns its own visible Chrome process over a private
CDP pipe. No extension, relay, remote-debugging TCP port, host profile, or credential
mount is used.

From the repository root in PowerShell:

```powershell
docker build --platform linux/amd64 `
  --file scripts/smoke/linux-chrome-live/Dockerfile `
  --tag newton-linux-chrome-live:node24 .

$results = Join-Path $env:TEMP "newton-linux-chrome-live-results"
New-Item -ItemType Directory -Force $results | Out-Null
$imageId = docker image inspect --format '{{.Id}}' newton-linux-chrome-live:node24
docker run --rm --init --platform linux/amd64 --shm-size 1g `
  --security-opt seccomp=unconfined `
  --env "NEWTON_IMAGE_ID=$imageId" `
  --mount "type=bind,source=$((Get-Location).Path),target=/workspace-source,readonly" `
  --mount "type=bind,source=$results,target=/results" `
  newton-linux-chrome-live:node24
```

The entrypoint verifies that the source bind is read-only, rejects links, special
files, oversized inputs, and non-allowlisted file types, and copies only required
source. Each invocation owns a unique result directory with an immediate in-progress
receipt. Every invoked build/live command is drained through a 64 KiB tail collector;
persisted diagnostics contain only bounded categories, byte counts, hashes, and closed
step identifiers. Raw browser/page output is deleted with the identity-checked run root.

The runner builds and packs Newton, starts Xvfb, then executes the agent-cost gate,
the complete direct live suite, the public real-site suite, and an exact-tarball
install/run of the packed Chrome runtime. Each test owns and
cleans its browser process, private CDP pipe, policy proxy, identity, and lease.
Receipts record the source digest, browser/runtime versions, selected package versions,
image identifier, and exact gate statuses. This narrows, rather than guarantees,
reproducibility because transitive Debian and registry responses are not mirrored.

Docker Desktop's default seccomp profile blocks the user-namespace operation used by
the Chrome for Testing sandbox. The command relaxes the container seccomp profile while
retaining Chrome's root-owned mode-4755 sandbox helper; Newton never adds `--no-sandbox`.
