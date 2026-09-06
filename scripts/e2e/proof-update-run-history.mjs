// Task-only observation, added to the harness after the exact candidate is packed.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function instrument() {
  const harness = "scripts/e2e/lib/upgrade-survivor/update-first-hop-compat.sh";
  let source = readFileSync(harness, "utf8");
  const updateAnchor = "run_update() {\n";
  assert.equal(source.split(updateAnchor).length, 2, "Missing unique top-level update seam");
  // Each top-level update starts without continuation metadata. Modern parents
  // must create and forward their own ID through the actual packaged updater.
  source = source.replace(
    updateAnchor,
    `${updateAnchor}  unset OPENCLAW_UPDATE_RUN_ID OPENCLAW_UPDATE_POST_CORE\n`,
  );
  for (const [hop, selectedPackage] of [
    ["first", "$CANDIDATE_PACKAGE"],
    ["second", "$FUTURE_PACKAGE"],
  ]) {
    const anchor = `  record_service_state "$ARTIFACT_DIR/$lane-service-after-${hop}.txt"\n`;
    assert.equal(source.split(anchor).length, 2, `Missing unique ${hop}-hop capture seam`);
    source = source.replace(
      anchor,
      `${anchor}  capture_update_history "$lane-${hop}" "${selectedPackage}"\n`,
    );
  }
  const anchor = "run_negative_control\nrun_positive_hops\n";
  assert.equal(source.split(anchor).length, 2, "Missing unique first-hop invocation seam");
  source = source.replace(
    anchor,
    `${String.raw`
capture_update_history() {
  local stage="$1" selected_package="$2"
  tar -xOf "$SOURCE_PACKAGE" package/package.json >"$ARTIFACT_DIR/source-package.json"
  tar -xOf "$selected_package" package/package.json >"$ARTIFACT_DIR/$stage-package.json"
  openclaw --version >"$ARTIFACT_DIR/$stage-version.txt"
  local health_ready=0
  for attempt in $(seq 1 12); do
    if openclaw health --json --timeout 10000 \
      >"$ARTIFACT_DIR/$stage-health.json" \
      2>"$ARTIFACT_DIR/$stage-health.stderr"; then
      health_ready=1
      break
    fi
    cp "$ARTIFACT_DIR/$stage-health.stderr" \
      "$ARTIFACT_DIR/$stage-health-attempt-$attempt.stderr"
    sleep 1
  done
  if [ "$health_ready" -ne 1 ]; then
    echo "$stage Gateway RPC did not become healthy" >&2
    cat "$ARTIFACT_DIR/$stage-health.stderr" >&2
    return 1
  fi
  openclaw gateway status --json >"$ARTIFACT_DIR/$stage-status.json" \
    2>"$ARTIFACT_DIR/$stage-status.stderr"
  node scripts/e2e/proof-update-run-history.mjs capture \
    "$stage" "$ARTIFACT_DIR" "$OPENCLAW_STATE_DIR/state/openclaw.sqlite" "$selected_package"
}

`}${anchor}`,
  );
  writeFileSync(harness, source);
}

function capture(stage, artifactDir, databasePath, selectedPackage) {
  assert.ok(stage === "positive-first" || stage === "positive-second", "Unknown proof stage");
  const readJson = (name) => JSON.parse(readFileSync(path.join(artifactDir, name), "utf8"));
  const result = readJson(`${stage}.stdout`);
  const expected = readJson(`${stage}-package.json`);
  const health = readJson(`${stage}-health.json`);
  const status = readJson(`${stage}-status.json`);
  const legacy = stage === "positive-first";
  const before = readJson(legacy ? "source-package.json" : "positive-first-package.json");

  // Read every retained row. A latest-run query could hide a second orphan row.
  // Read-only opening also refuses a missing database instead of creating empty proof.
  const db = new DatabaseSync(databasePath, { readOnly: true });
  let rows;
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE name = 'update_runs'").get();
    rows = table
      ? db.prepare("SELECT * FROM update_runs ORDER BY created_at_ms, run_id").all()
      : [];
  } finally {
    db.close();
  }
  writeFileSync(
    path.join(artifactDir, `${stage}-history.json`),
    `${JSON.stringify(rows, null, 2)}\n`,
  );

  assert.equal(result.status, "ok", "Updater did not finish successfully");
  assert.ok(result.postUpdate?.plugins, "Missing post-core plugin finalization result");
  assert.notEqual(result.postUpdate.plugins.status, "error", "Plugin finalization failed");
  assert.equal(result.before?.version, before.version, "Updater lost the starting version");
  assert.equal(
    result.after?.version,
    expected.version,
    "Updater did not install the target version",
  );
  assert.equal(health.ok, true, "Gateway health RPC failed");
  assert.equal(status.rpc?.ok, true, "Gateway status RPC failed");
  assert.equal(
    status.rpc.server?.version,
    expected.version,
    "Running Gateway has the wrong version",
  );
  assert.equal(rows.length, legacy ? 0 : 1, "Unexpected retained update history");
  if (!legacy) {
    const row = rows[0];
    assert.equal(row.run_id, result.runId, "History does not belong to the parent updater");
    assert.equal(row.status, "succeeded", "Modern parent did not complete its history entry");
    assert.equal(row.phase, "finished", "Modern history is still in progress");
    assert.ok(row.finished_at_ms > 0, "Missing terminal timestamp");
    assert.equal(
      JSON.parse(row.before_json).version,
      before.version,
      "History lost the starting version",
    );
    assert.equal(
      JSON.parse(row.after_json).version,
      expected.version,
      "History lost the installed version",
    );
    assert.equal(
      JSON.parse(row.target_json).tag,
      selectedPackage,
      "History lost the requested target",
    );
    const pluginStep = JSON.parse(row.steps_json).find(
      (step) => step.step === "post-update verification",
    );
    assert.equal(
      pluginStep?.status,
      "completed",
      "Modern parent did not record plugin finalization",
    );
  }
  const summary = {
    stage,
    before: before.version,
    after: expected.version,
    finalization: result.postUpdate.plugins.status,
    historyRows: rows.length,
    runId: result.runId ?? null,
    gatewayVersion: status.rpc.server.version,
    gatewayHealthy: true,
  };
  writeFileSync(
    path.join(artifactDir, `${stage}-proof.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  console.log(JSON.stringify(summary));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "instrument") {
  instrument();
} else if (mode === "capture" && args.length === 4) {
  capture(...args);
} else {
  throw new Error(
    "usage: proof-update-run-history.mjs instrument | capture <stage> <artifacts> <database> <target>",
  );
}
