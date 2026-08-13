#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_ARGUMENT="${NEWTON_SOURCE_ROOT:-/workspace-source}"
RESULTS_ARGUMENT="${NEWTON_RESULTS_ROOT:-/results}"
RECEIPT_TOOL=/usr/local/lib/newton-harness-receipt.mjs
PREPARE_TOOL=/usr/local/lib/newton-prepare-workspace.mjs
BOUNDED_COMMAND=/usr/local/lib/newton-bounded-command.mjs
umask 077
RESULTS_ROOT="$(readlink -f -- "$RESULTS_ARGUMENT")"
if [[ ! -d "$RESULTS_ROOT" || ! -w "$RESULTS_ROOT" || "$RESULTS_ROOT" == "/" ]]; then
  echo "results root must be an existing writable directory" >&2
  exit 64
fi

RUN_ID="linux-cft-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(10).toString("hex"))')"
RESULT_RUN_ROOT="$RESULTS_ROOT/$RUN_ID"
mkdir --mode=0700 -- "$RESULT_RUN_ROOT"
node "$RECEIPT_TOOL" start "$RESULT_RUN_ROOT" "$RUN_ID"
printf '{"runId":"%s","receiptDirectory":"%s"}\n' "$RUN_ID" "$RESULT_RUN_ROOT"

RUN_ROOT="$(mktemp -d /tmp/newton-linux-chrome-live.XXXXXX)"
case "$RUN_ROOT" in /tmp/newton-linux-chrome-live.??????) ;; *) echo "unsafe run root" >&2; exit 70 ;; esac
RUN_ROOT_REAL="$(readlink -f -- "$RUN_ROOT")"
if [[ "$RUN_ROOT_REAL" != "$RUN_ROOT" || -L "$RUN_ROOT" || ! -d "$RUN_ROOT" ]]; then
  echo "unsafe run root identity" >&2
  exit 70
fi
RUN_OWNER="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
printf '%s' "$RUN_OWNER" >"$RUN_ROOT/.owner"
chmod 0600 "$RUN_ROOT/.owner"
WORKSPACE_ROOT="$RUN_ROOT/workspace"
PROFILE_ROOT="$RUN_ROOT/profile"
RAW_LOG_ROOT="$RUN_ROOT/raw-logs"
mkdir -p "$WORKSPACE_ROOT" "$PROFILE_ROOT/home" "$PROFILE_ROOT/config" \
  "$PROFILE_ROOT/cache" "$RAW_LOG_ROOT"

export HOME="$PROFILE_ROOT/home"
export XDG_CONFIG_HOME="$PROFILE_ROOT/config"
export XDG_CACHE_HOME="$PROFILE_ROOT/cache"
export PNPM_HOME="$PROFILE_ROOT/pnpm-home"
export PATH="$PNPM_HOME:$PATH"

XVFB_PID=""
STAGE=source_preflight
DIRECT_SELECTION_STATUS=null
AGENT_COST_STATUS=null
LIVE_STATUS=null
PACKED_LIVE_STATUS=null

record_log() {
  local file=$1 label=$2 status=$3
  if [[ -f "$file" ]]; then
    node "$RECEIPT_TOOL" log "$file" "$RESULT_RUN_ROOT/$label.json" "$label" "$status" || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [[ -n "$XVFB_PID" ]] && kill -0 "$XVFB_PID" 2>/dev/null; then
    kill "$XVFB_PID" 2>/dev/null
    wait "$XVFB_PID" 2>/dev/null
  fi
  node "$RECEIPT_TOOL" final "$RESULT_RUN_ROOT" "$RUN_ID" "$STAGE" "$status" \
    "$DIRECT_SELECTION_STATUS" "$AGENT_COST_STATUS" "$LIVE_STATUS" "$PACKED_LIVE_STATUS" || true
  if [[ "$RUN_ROOT" == /tmp/newton-linux-chrome-live.?????? \
        && "$(readlink -f -- "$RUN_ROOT" 2>/dev/null)" == "$RUN_ROOT_REAL" \
        && ! -L "$RUN_ROOT" && -d "$RUN_ROOT" \
        && -f "$RUN_ROOT/.owner" && ! -L "$RUN_ROOT/.owner" \
        && "$(cat -- "$RUN_ROOT/.owner" 2>/dev/null)" == "$RUN_OWNER" \
        && "$WORKSPACE_ROOT" == "$RUN_ROOT/workspace" \
        && "$PROFILE_ROOT" == "$RUN_ROOT/profile" \
        && "$RAW_LOG_ROOT" == "$RUN_ROOT/raw-logs" ]]; then
    rm -rf -- "$RUN_ROOT"
  else
    echo "refusing to clean unexpected run root: $RUN_ROOT" >&2
    status=70
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

SOURCE_ROOT="$(readlink -f -- "$SOURCE_ARGUMENT")"
if [[ "$SOURCE_ROOT" == "/" || ! -f "$SOURCE_ROOT/package.json" ]]; then
  echo "workspace source must be a Newton Browser checkout" >&2
  exit 64
fi
case "$RESULT_RUN_ROOT/" in "$SOURCE_ROOT"/*) echo "results must not be inside source" >&2; exit 64 ;; esac
case "$SOURCE_ROOT/" in "$RESULTS_ROOT"/*) echo "source must not be inside results" >&2; exit 64 ;; esac

# This helper verifies that the bind mount is read-only, rejects links and
# special files, and copies only an explicit source-file allowlist.
node "$PREPARE_TOOL" "$SOURCE_ROOT" "$WORKSPACE_ROOT" >"$RUN_ROOT/source.json"
cp -- "$RUN_ROOT/source.json" "$RESULT_RUN_ROOT/source.json"
SOURCE_TREE_SHA256="$(node -e 'const v=require(process.argv[1]); if(!/^[a-f0-9]{64}$/.test(v.sourceTreeSha256)) process.exit(1); process.stdout.write(v.sourceTreeSha256)' "$RUN_ROOT/source.json")"

cd "$WORKSPACE_ROOT"
STAGE=workspace_build
set +e
node "$BOUNDED_COMMAND" "$RAW_LOG_ROOT/install.log" pnpm install --frozen-lockfile
INSTALL_STATUS=$?
set -e
record_log "$RAW_LOG_ROOT/install.log" install-diagnostics "$INSTALL_STATUS"
if (( INSTALL_STATUS != 0 )); then exit "$INSTALL_STATUS"; fi
set +e
node "$BOUNDED_COMMAND" "$RAW_LOG_ROOT/build.log" pnpm build
BUILD_STATUS=$?
set -e
record_log "$RAW_LOG_ROOT/build.log" build-diagnostics "$BUILD_STATUS"
if (( BUILD_STATUS != 0 )); then exit "$BUILD_STATUS"; fi
set +e
node "$BOUNDED_COMMAND" "$RAW_LOG_ROOT/pack.log" pnpm pack:check
PACK_STATUS=$?
set -e
record_log "$RAW_LOG_ROOT/pack.log" pack-diagnostics "$PACK_STATUS"
if (( PACK_STATUS != 0 )); then exit "$PACK_STATUS"; fi
DIRECT_SELECTION_STATUS=0

STAGE=browser_start
DISPLAY_PIPE="$RUN_ROOT/xvfb-display"
mkfifo "$DISPLAY_PIPE"
Xvfb -displayfd 3 -screen 0 1440x1000x24 -nolisten tcp 3>"$DISPLAY_PIPE" \
  >/dev/null 2>&1 &
XVFB_PID=$!
IFS= read -r DISPLAY_NUMBER <"$DISPLAY_PIPE"
rm -f -- "$DISPLAY_PIPE"
export DISPLAY=":$DISPLAY_NUMBER"

OS_ID="$(. /etc/os-release && printf '%s' "$PRETTY_NAME")"
NODE_VERSION="$(node --version)"
PNPM_VERSION="$(pnpm --version)"
CHROME_VERSION="$(google-chrome --version)"
CHROME_SOURCE="https://storage.googleapis.com/chrome-for-testing-public/${CHROME_FOR_TESTING_VERSION}/linux64/chrome-linux64.zip"
IMAGE_IDENTIFIER="${NEWTON_IMAGE_ID:-unknown}"
if [[ "$IMAGE_IDENTIFIER" != unknown && ! "$IMAGE_IDENTIFIER" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "NEWTON_IMAGE_ID must be a Docker sha256 image identifier" >&2
  exit 64
fi
dpkg-query --show --showformat='${Package}=${Version}\n' xvfb curl libgtk-3-0 >"$RUN_ROOT/packages.txt"
export OS_ID NODE_VERSION PNPM_VERSION CHROME_VERSION CHROME_SOURCE
export SOURCE_TREE_SHA256 IMAGE_IDENTIFIER RUN_ROOT
node - "$RESULT_RUN_ROOT/versions.json" <<'NODE'
const fs = require("node:fs");
const [output] = process.argv.slice(2);
const value = {
  os: process.env.OS_ID, node: process.env.NODE_VERSION, pnpm: process.env.PNPM_VERSION,
  chromeFlavor: "Chrome for Testing Stable full browser", chrome: process.env.CHROME_VERSION,
  chromeSource: process.env.CHROME_SOURCE, chromeSha256: process.env.CHROME_FOR_TESTING_SHA256,
  architecture: "owned_process_private_cdp",
  sourceTreeSha256: process.env.SOURCE_TREE_SHA256,
  imageIdentifier: process.env.IMAGE_IDENTIFIER,
  resolvedPackages: fs.readFileSync(process.env.RUN_ROOT + "/packages.txt", "utf8").trim().split("\n"),
};
fs.writeFileSync(output, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 });
NODE

STAGE=agent_cost
set +e
node "$BOUNDED_COMMAND" "$RAW_LOG_ROOT/agent-cost.log" pnpm eval:agent-cost
AGENT_COST_STATUS=$?
set -e
record_log "$RAW_LOG_ROOT/agent-cost.log" agent-cost-diagnostics "$AGENT_COST_STATUS"
if (( AGENT_COST_STATUS != 0 )); then
  exit "$AGENT_COST_STATUS"
fi

STAGE=direct_live
set +e
NEWTON_BROWSER_QA_BROWSER=chrome node "$BOUNDED_COMMAND" "$RAW_LOG_ROOT/eval-live.log" pnpm eval:direct-live
LIVE_STATUS=$?
set -e
record_log "$RAW_LOG_ROOT/eval-live.log" eval-live-diagnostics "$LIVE_STATUS"
if (( LIVE_STATUS == 0 )); then
  STAGE=real_sites
  set +e
  NEWTON_BROWSER_QA_BROWSER=chrome node "$BOUNDED_COMMAND" "$RAW_LOG_ROOT/real-sites.log" pnpm eval:real-sites
  LIVE_STATUS=$?
  set -e
  record_log "$RAW_LOG_ROOT/real-sites.log" real-sites-diagnostics "$LIVE_STATUS"
fi
if (( LIVE_STATUS == 0 )); then
  STAGE=packed_direct
  set +e
  NEWTON_BROWSER_QA_BROWSER=chrome node "$BOUNDED_COMMAND" "$RAW_LOG_ROOT/packed-direct.log" pnpm smoke:packed-direct
  PACKED_LIVE_STATUS=$?
  set -e
  record_log "$RAW_LOG_ROOT/packed-direct.log" packed-direct-diagnostics "$PACKED_LIVE_STATUS"
fi
if (( LIVE_STATUS != 0 )); then exit "$LIVE_STATUS"; fi
if (( PACKED_LIVE_STATUS == 0 )); then STAGE=complete; fi
exit "$PACKED_LIVE_STATUS"
