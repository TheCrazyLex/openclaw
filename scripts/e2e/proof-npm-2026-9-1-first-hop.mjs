// Task-only instrumentation, applied after the exact candidate has been packed.
import { readFileSync, writeFileSync } from "node:fs";

const harness = "scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh";
const original = readFileSync(harness, "utf8");
const anchor = '  record_service_state "$ARTIFACT_DIR/$lane-service-after-first.txt"\n';
if (original.split(anchor).length !== 2) {
  throw new Error("Expected exactly one first-hop evidence insertion point");
}

// The existing active check observes the service-manager shim's process. Probe
// the actual Gateway RPC before the future hop can replace this candidate.
const capture = String.raw`
  openclaw --version >"$ARTIFACT_DIR/$lane-first-version.txt"
  local health_ready=0
  for attempt in $(seq 1 12); do
    if openclaw health --json --timeout 10000 \
      >"$ARTIFACT_DIR/$lane-first-health.json" \
      2>"$ARTIFACT_DIR/$lane-first-health.stderr"; then
      health_ready=1
      break
    fi
    cp "$ARTIFACT_DIR/$lane-first-health.stderr" \
      "$ARTIFACT_DIR/$lane-first-health-attempt-$attempt.stderr"
    sleep 1
  done
  if [ "$health_ready" -ne 1 ]; then
    echo "First-hop Gateway RPC did not become healthy" >&2
    cat "$ARTIFACT_DIR/$lane-first-health.stderr" >&2
    return 1
  fi
  node -e '
    const fs = require("node:fs");
    const health = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (health.ok !== true) throw new Error("First-hop health.ok was not true");
  ' "$ARTIFACT_DIR/$lane-first-health.json"
  openclaw gateway status --json >"$ARTIFACT_DIR/$lane-first-status.json" \
    2>"$ARTIFACT_DIR/$lane-first-status.stderr"
  tar -xOf "$CANDIDATE_PACKAGE" package/package.json \
    >"$ARTIFACT_DIR/$lane-first-expected-package.json"
  node -e '
    const fs = require("node:fs");
    const status = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expected = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    if (status.rpc?.ok !== true) throw new Error("First-hop status RPC failed");
    if (status.rpc.server?.version !== expected.version) {
      throw new Error("Running Gateway version did not match the candidate package");
    }
  ' "$ARTIFACT_DIR/$lane-first-status.json" "$ARTIFACT_DIR/$lane-first-expected-package.json"
`;

writeFileSync(harness, original.replace(anchor, anchor + capture));
