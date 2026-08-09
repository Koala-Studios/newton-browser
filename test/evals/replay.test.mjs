import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMachineReport,
  renderMarkdownReport,
  serializeMachineReport,
  writeLocalEvalReports,
} from "../../scripts/evals/report.mjs";
import {
  EvalSchemaError,
  parseEvalTaskFromDirectory,
  parseEvalTask,
} from "../../scripts/evals/schema.mjs";
import { replayTask, replayTasks, fixtureResolveRef } from "../../scripts/evals/replay.mjs";

const tasksDir = path.join("test", "evals", "tasks");

const START_TIME = "2026-08-08T12:00:00.000Z";
const END_TIME = "2026-08-08T12:00:00.100Z";

function createRunner(plan) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    const entry = plan[calls.length - 1];
    if (entry instanceof Error) throw entry;
    if (typeof entry === "function") return entry(request);
    if (entry === undefined) return { status: "completed" };
    return entry;
  };
  return { fn, calls };
}

function taskResult(base = {}) {
  return {
    taskId: base.taskId ?? "report-task",
    fixture: base.fixture ?? "fixture-id",
    status: base.status ?? "passed",
    startedAt: base.startedAt ?? START_TIME,
    finishedAt: base.finishedAt ?? END_TIME,
    durationMs: base.durationMs ?? 100,
    steps: base.steps ?? [
      {
        index: 0,
        tool: "browser.act",
        expect: { status: "completed" },
        status: "completed",
        reason: "ok",
        passed: true,
        forbidden: { violated: false, matchCount: 0 },
      },
    ],
    ...base,
  };
}

function evalTask(overrides = {}) {
  return parseEvalTask(
    {
      id: overrides.id ?? "t1",
      fixture: "test/fixtures/app/index.html",
      grant: ["http://127.0.0.1:4310"],
      steps: [
        { tool: "browser.session.start", expect: "completed" },
        {
          tool: "browser.act",
          expect: "completed",
          action: {
            kind: "click",
            target: {
              role: "button",
              name: "Save",
            },
          },
        },
      ],
      forbid: [],
      ...overrides,
    },
    `task:${overrides.id ?? "t1"}`,
  );
}

test("checked-in task catalog replays deterministically without a provider", async () => {
  const tasks = parseEvalTaskFromDirectory(tasksDir).filter((task) => task.id !== "forbidden-effect-caught");
  assert.equal(tasks.some((task) => task.id === "input-key-fidelity"), true);
  assert.equal(tasks.some((task) => task.id === "dialog-renderer-categories"), true);
  const results = await replayTasks(tasks, {
    now: () => Date.parse(START_TIME),
    runner: async ({ task, step }) => {
      if (step.tool !== "browser.observe") return { status: step.expect.status };
      const duplicate = task.id === "ambiguous-ref-resolution";
      return {
        status: step.expect.status,
        result: {
          kind: "observation",
          nodes: [
            { ref: "d1:e1", role: "button", name: "Delete record" },
            ...(duplicate ? [{ ref: "d1:e2", role: "button", name: "Delete record" }] : []),
          ],
        },
      };
    },
  });
  assert.equal(results.every((result) => result.status === "passed"), true, JSON.stringify(results));
});

test("checked-in forbidden-effect task fails on its declared effect", async () => {
  const task = parseEvalTaskFromDirectory(tasksDir).find((entry) => entry.id === "forbidden-effect-caught");
  assert.ok(task);
  const result = await replayTask(task, {
    runner: async ({ step }) => step.tool === "browser.act"
      ? {
          status: "completed",
          effects: [{ origin: "http://127.0.0.1:4311", method: "POST", type: "http" }],
        }
      : { status: "completed" },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.steps[1].forbidden.violated, true);
  assert.equal(result.steps[1].forbidden.matchCount, 1);
});

test("replay isolates all local roots and rejects writes outside them", async () => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), "newton-eval-parent-"));
  const simulatedRealHome = path.join(parent, "simulated-real-home");
  const sentinel = path.join(simulatedRealHome, "sentinel.txt");
  await fs.promises.mkdir(simulatedRealHome);
  await fs.promises.writeFile(sentinel, "unchanged", "utf8");
  let isolatedRoot = "";
  try {
    const result = await replayTask(evalTask({ id: "hermetic-roots", steps: [
      { tool: "browser.session.start", expect: "completed" },
    ] }), {
      hermetic: {
        parent,
        async beforeCleanup(roots, taskResultValue) {
          isolatedRoot = roots.root;
          for (const name of ["home", "config", "cache", "profile", "downloads", "output"]) {
            assert.equal(fs.statSync(roots[name]).isDirectory(), true);
          }
          const report = buildMachineReport([taskResultValue], { runId: "hermetic", generatedAt: START_TIME });
          const written = await writeLocalEvalReports(report, { outputRoot: roots.output, baseName: "hermetic" });
          roots.recordWrite(written.machinePath);
          roots.recordWrite(written.markdownPath);
          assert.equal(written.machineBytes > 0, true);
          assert.equal(written.markdownBytes > 0, true);
        },
      },
      runner: async ({ context }) => {
        const artifactPath = context.recordLocalWrite(path.join(context.hermetic.output, "runner-artifact.json"));
        await fs.promises.writeFile(artifactPath, "{}", "utf8");
        assert.throws(() => context.recordLocalWrite(sentinel), /escaped hermetic root/);
        return { status: "completed" };
      },
    });
    assert.equal(result.status, "passed");
    assert.equal(await fs.promises.readFile(sentinel, "utf8"), "unchanged");
    assert.equal(fs.existsSync(isolatedRoot), false);
  } finally {
    await fs.promises.rm(parent, { recursive: true, force: true });
  }
});

test("schema rejects malformed task payloads", () => {
  const cases = [
    {
      id: "malformed-root",
      value: {
        id: 1234,
        steps: "not-array",
        grant: [],
        fixture: false,
        forbid: [{}],
      },
    },
    {
      id: "oversized-query",
      value: {
        id: "oversized-query",
        fixture: "test/fixtures/app/index.html",
        grant: ["http://127.0.0.1:4310"],
        steps: [
          { tool: "browser.session.start", expect: "completed", query: "x".repeat(1025) },
        ],
        forbid: [],
      },
    },
    {
      id: "credentialed-origin",
      value: {
        id: "credentialed-origin",
        fixture: "test/fixtures/app/index.html",
        grant: ["https://user:pass@127.0.0.1"],
        steps: [{ tool: "browser.session.start", expect: "completed" }],
        forbid: [],
      },
    },
    {
      id: "invalid-step",
      value: {
        id: "invalid-step",
        fixture: "test/fixtures/app/index.html",
        grant: ["http://127.0.0.1:4310"],
        steps: ["bad"],
        forbid: [],
      },
    },
    {
      id: "missing-steps",
      value: {
        id: "missing-steps",
        fixture: "test/fixtures/app/index.html",
        grant: ["http://127.0.0.1:4310"],
        steps: [],
        forbid: [],
      },
    },
    {
      id: "invalid-grant",
      value: {
        id: "invalid-grant",
        fixture: "test/fixtures/app/index.html",
        grant: ["ftp://127.0.0.1"],
        steps: [{ tool: "browser.session.start", expect: "completed" }],
        forbid: [],
      },
    },
  ];

  for (const entry of cases) {
    assert.throws(() => parseEvalTask(entry.value, entry.id), EvalSchemaError);
  }
});

test("schema rejects nested unknown keys", () => {
  const base = {
    id: "nested",
    fixture: "test/fixtures/app/index.html",
    grant: ["http://127.0.0.1:4310"],
    steps: [
      {
        tool: "browser.act",
        expect: "completed",
        action: {
          kind: "click",
          target: {
            role: "button",
            name: "Save",
          },
        },
      },
    ],
    forbid: [],
  };

  const cases = [
    {
      id: "semantic",
      value: {
        ...base,
        id: "nested-semantic",
        steps: [
          { ...base.steps[0], semanticRef: { role: "button", unknown: "x" } },
        ],
      },
    },
    {
      id: "waitfor",
      value: {
        ...base,
        id: "nested-waitfor",
        steps: [
          { tool: "browser.wait_for", expect: "completed", waitFor: { state: "visible", unknown: "x" } },
        ],
      },
    },
    {
      id: "action",
      value: {
        ...base,
        id: "nested-action",
        steps: [
          { ...base.steps[0], action: { ...base.steps[0].action, unknown: "x" } },
        ],
      },
    },
    {
      id: "target",
      value: {
        ...base,
        id: "nested-target",
        steps: [
          {
            ...base.steps[0],
            action: {
              ...base.steps[0].action,
              target: { role: "button", unknown: "x" },
            },
          },
        ],
      },
    },
    {
      id: "forbid-array",
      value: {
        ...base,
        id: "nested-forbid-array",
        steps: [{ tool: "browser.session.start", expect: "completed" }],
        forbid: [{ origin: "http://127.0.0.1:4310", unknown: "x" }],
      },
    },
    {
      id: "step",
      value: {
        ...base,
        id: "nested-step",
        steps: [{ ...base.steps[0], unknown: "x" }],
      },
    },
  ];

  for (const entry of cases) {
    assert.throws(() => parseEvalTask(entry.value, entry.id), EvalSchemaError);
  }
});

test("schema path validation accepts root and rejects traversal/control", () => {
  const badPaths = ["/api/../secret", "/a//b", "/a%2F%2e%2e%2fb", "\\/x", "/a?x=1", "/a#x", "a%2f../b"];
  const ok = parseEvalTask({
    id: "path-ok",
    fixture: "test/fixtures/app/index.html",
    grant: ["http://127.0.0.1:4310"],
    steps: [{ tool: "browser.session.start", expect: "completed" }],
    forbid: [{ origin: "http://127.0.0.1:4310", path: "/" }],
  }, "path-ok");
  assert.equal(ok.forbid[0].path, "/");

  for (const [index, pathValue] of badPaths.entries()) {
    assert.throws(
      () =>
        parseEvalTask({
          id: `bad-path-${index}`,
          fixture: "test/fixtures/app/index.html",
          grant: ["http://127.0.0.1:4310"],
          steps: [{ tool: "browser.session.start", expect: "completed" }],
          forbid: [{ origin: "http://127.0.0.1:4310", path: pathValue }],
        }, `bad-path-${index}`),
      EvalSchemaError,
    );
  }

  assert.equal(parseEvalTask({
    id: "fixture-path-ok",
    fixture: "test/fixtures/app/index.html",
    grant: ["http://127.0.0.1:4310"],
    steps: [{ tool: "browser.session.start", expect: "completed" }],
    forbid: [],
  }, "fixture-path-ok").fixture, "test/fixtures/app/index.html");

  const badFixture = [
    "/test/fixtures/app/index.html",
    "C:/secrets/creds.json",
    "test\\fixtures\\app\\index.html",
    "test/fixtures/\u0000index.html",
    "test/fixtures/app?x=1",
  ];
  for (const [index, fixture] of badFixture.entries()) {
    assert.throws(() => {
      parseEvalTask({
        id: `fixture-bad-${index}`,
        fixture,
        grant: ["http://127.0.0.1:4310"],
        steps: [{ tool: "browser.session.start", expect: "completed" }],
        forbid: [],
      }, `fixture-bad-${index}`);
    }, EvalSchemaError);
  }
});

test("ambiguous resolution returns ambiguous and does not dispatch", async () => {
  const task = parseEvalTask({
    id: "ambiguous-ref-resolution",
    fixture: "test/fixtures/app/index.html",
    grant: ["http://127.0.0.1:4310"],
    steps: [
      { tool: "browser.session.start", expect: "completed" },
      { tool: "browser.observe", expect: "completed", query: "form" },
      {
        tool: "browser.act",
        expect: "ambiguous",
        action: { kind: "click" },
        semanticRef: { role: "button", name: "Delete record" },
      },
    ],
    forbid: [],
  }, "ambiguous-ref-resolution");

  const runner = createRunner([
    { status: "completed" },
    {
      status: "completed",
      result: {
        kind: "observation",
        nodes: [
          { ref: "button:0", role: "button", name: "Delete record" },
          { ref: "button:1", role: "button", name: "Delete record" },
        ],
      },
    },
  ]);

  const result = await replayTask(task, {
    runner: runner.fn,
    fixtureAdapter: { resolveRef: fixtureResolveRef },
  });

  assert.equal(result.steps[2].status, "ambiguous");
  assert.equal(result.steps[2].passed, true);
  assert.equal(result.status, "passed");
  assert.equal(runner.calls.length, 2);
});

test("expected ambiguity can pass with no runner dispatch", async () => {
  const task = parseEvalTask({
    id: "ambiguous-expected-pass",
    fixture: "test/fixtures/app/index.html",
    grant: ["http://127.0.0.1:4310"],
    steps: [
      { tool: "browser.session.start", expect: "completed" },
      { tool: "browser.observe", expect: "completed", query: "form" },
      {
        tool: "browser.act",
        expect: "ambiguous",
        action: { kind: "click" },
        semanticRef: { role: "button", name: "Delete record" },
      },
    ],
    forbid: [],
  }, "ambiguous-expected-pass");

  const runner = createRunner([{ status: "completed" }, { status: "completed" }]);

  const result = await replayTask(task, {
    runner: runner.fn,
    fixtureAdapter: {
      resolveRef: () => ({ status: "ambiguous", reason: "duplicate" }),
    },
  });

  assert.equal(result.steps[2].status, "ambiguous");
  assert.equal(result.steps[2].passed, true);
  assert.equal(runner.calls.length, 2);
});

test("observe->ack->semantic uses last observation", async () => {
  const task = parseEvalTask({
    id: "observe-ack-semantic",
    fixture: "test/fixtures/app/index.html",
    grant: ["http://127.0.0.1:4310"],
    steps: [
      { tool: "browser.session.start", expect: "completed" },
      { tool: "browser.observe", expect: "completed", query: "form" },
      { tool: "browser.screenshot", expect: "completed" },
      {
        tool: "browser.act",
        expect: "completed",
        action: { kind: "click" },
        semanticRef: {
          role: "button",
          name: "Delete",
        },
      },
    ],
    forbid: [],
  }, "observe-ack-semantic");

  let observationSeen = false;
  const result = await replayTask(task, {
    runner: createRunner([
      { status: "completed" },
      {
        status: "completed",
        result: {
          kind: "observation",
          nodes: [{ ref: "btn-delete", role: "button", name: "Delete" }],
        },
      },
      { status: "completed", result: { kind: "ack" } },
      { status: "completed" },
    ]).fn,
    fixtureAdapter: {
      resolveRef: ({ previousObservation }) => {
        observationSeen = previousObservation?.kind === "observation";
        return { status: "resolved", ref: "btn-delete", reason: "resolved" };
      },
    },
  });

  assert.equal(observationSeen, true);
  assert.equal(result.status, "passed");
});

test("forbidding uses requestId and path matching", async () => {
  const task = parseEvalTask({
    id: "forbid-request-id",
    fixture: "test/fixtures/app/index.html",
    grant: ["https://127.0.0.1:4310"],
    steps: [
      { tool: "browser.session.start", expect: "completed" },
      {
        tool: "browser.act",
        expect: "completed",
        action: {
          kind: "click",
          target: { role: "button", name: "Save" },
        },
      },
    ],
    forbid: [
      {
        origin: "https://127.0.0.1:4310",
        path: "/api/users",
        method: "GET",
        requestId: "req-1",
      },
    ],
  }, "forbid-request-id");

  const result = await replayTask(task, {
    runner: createRunner([
      { status: "completed" },
      {
        status: "completed",
        result: { kind: "ack" },
        effects: [
          {
            origin: "https://127.0.0.1:4310",
            method: "GET",
            path: "/api/users",
            requestId: "req-1",
          },
        ],
      },
    ]).fn,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.steps[1].forbidden.violated, true);
});

test("malformed runner outcome set always maps to contract-invalid", async () => {
  const outcomes = [
    {},
    { status: "completed", reason: { text: "bad" } },
    { status: "completed", result: "bad" },
    { status: "completed", result: { kind: "bad-kind" } },
    { status: "completed", result: { kind: "observation", nodes: { bad: true } } },
    { status: "failed", effects: [] },
    { status: "completed", error: { code: "runner_error" } },
  ];

  for (let index = 0; index < outcomes.length; index += 1) {
    const result = await replayTask(evalTask({ id: `malformed-${index}` }), {
      runner: createRunner([{ status: "completed" }, outcomes[index]]).fn,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.steps[1].status, "runner_contract_invalid");
    assert.equal(result.steps[1].error.code, "runner_contract_invalid");
  }
});

for (const kind of ["ack", "screenshot", "console_log", "network_log"]) {
  test(`non-observation kinds can omit nodes: ${kind}`, async () => {
    const result = await replayTask(evalTask({ id: `result-${kind}`, steps: [
      { tool: "browser.session.start", expect: "completed" },
      { tool: "browser.screenshot", expect: "completed" },
    ] }), {
      runner: createRunner([{ status: "completed" }, { status: "completed", result: { kind } }]).fn,
    });

    assert.equal(result.status, "passed");
    assert.equal(result.steps[1].result.kind, kind);
    assert.equal(result.steps[1].result.nodes, undefined);
  });
}

test("observation nodes keep only allowlisted fields", async () => {
  const result = await replayTask(evalTask({ id: "node-fields" }), {
    runner: createRunner([
      { status: "completed" },
      {
        status: "completed",
        result: {
          kind: "observation",
          nodes: [{
            ref: "r1",
            role: "button",
            unknown: "secret",
            testId: "x",
            selector: "#x",
          }],
        },
      },
    ]).fn,
  });

  assert.equal(result.steps[1].result.nodes?.[0].unknown, undefined);
});

test("report normalizes invalid expect or status to failed", () => {
  const report = buildMachineReport([
    taskResult({
      taskId: "bad-expected",
      steps: [
        {
          index: 0,
          tool: "browser.act",
          expect: { status: "bogus" },
          status: "nonsense",
          reason: { leaked: "x" },
          passed: true,
          forbidden: { violated: false, matchCount: 1 },
        },
      ],
    }),
  ]);

  assert.equal(report.tasks[0].steps[0].passed, false);
  assert.equal(report.tasks[0].steps[0].error.code, "runner_contract_invalid");
  assert.equal(report.summary.failed, 1);

  for (const [id, code, passed] of [["valid-failed", "runner_error", true], ["missing-error", "runner_contract_invalid", false]]) {
    const result = buildMachineReport([taskResult({
      taskId: id,
      steps: [{ index: 0, tool: "browser.session.start", expect: { status: "failed" }, status: "failed", passed: true, forbidden: { violated: false, matchCount: 0 }, ...(code === "runner_error" ? { error: { code } } : {}) }],
    })]);
    assert.equal(result.tasks[0].steps[0].passed, passed);
    assert.equal(result.tasks[0].steps[0].error.code, code);
  }
});

test("report treats invalid tool as contract-invalid", () => {
  const report = buildMachineReport([
    taskResult({
      taskId: "bad-tool",
      steps: [
        {
          index: 0,
          tool: "browser.bad",
          expect: { status: "completed" },
          status: "completed",
          passed: true,
          forbidden: { violated: false, matchCount: 0 },
        },
      ],
    }),
  ]);

  assert.equal(report.tasks[0].steps[0].tool, "browser.session.start");
  assert.equal(report.tasks[0].steps[0].passed, false);
  assert.equal(report.tasks[0].steps[0].error.code, "runner_contract_invalid");
  assert.equal(report.summary.failed, 1);
});

test("report rejects unexpected error on otherwise passing outcome", () => {
  const report = buildMachineReport([
    taskResult({
      taskId: "unexpected-error",
      steps: [
        {
          index: 0,
          tool: "browser.session.start",
          expect: { status: "completed" },
          status: "completed",
          passed: true,
          forbidden: { violated: false, matchCount: 0 },
          error: { code: "runner_error" },
        },
      ],
    }),
  ]);

  assert.equal(report.tasks[0].steps[0].passed, false);
  assert.equal(report.tasks[0].steps[0].error.code, "runner_contract_invalid");
  assert.equal(report.summary.failed, 1);
});

test("outcome_unknown remains passable when it matches", () => {
  const report = buildMachineReport([
    taskResult({
      taskId: "outcome-unknown",
      steps: [
        {
          index: 0,
          tool: "browser.act",
          expect: { status: "outcome_unknown" },
          status: "outcome_unknown",
          passed: true,
          forbidden: { violated: false, matchCount: 0 },
        },
      ],
    }),
  ]);

  assert.equal(report.tasks[0].steps[0].passed, true);
  assert.equal(report.summary.passed, 1);
});

test("report with zero steps fails", () => {
  const report = buildMachineReport([taskResult({ taskId: "zero", steps: [] })]);
  assert.equal(report.tasks[0].status, "failed");
});

test("runId uses identifier whitelist and blocks newline/control/pipe injection", () => {
  const report = buildMachineReport([taskResult({ taskId: "ok" })], {
    runId: "bad\n|id\u0000",
  });
  assert.equal(report.runId, "run");
  const md = renderMarkdownReport(report);
  assert.equal(md.includes("bad\n|id"), false);
});

test("normalizeDate is total for hostile values", () => {
  const report = buildMachineReport([
    taskResult({
      taskId: "bad-date",
      startedAt: "not-a-date",
      finishedAt: {},
    }),
  ], {
    generatedAt: { toString: () => { throw new Error("bad"); } },
  });

  assert.equal(report.generatedAt, new Date(0).toISOString());
  assert.equal(report.tasks[0].startedAt, new Date(0).toISOString());
});

test("normalizeDuration behavior is strict", async (t) => {
  const report = buildMachineReport([taskResult({ taskId: "bad-duration", durationMs: { valueOf: () => { throw new Error("bad"); } } })]);
  assert.equal(report.tasks[0].durationMs, 0);
  await t.test("non-number duration values are rejected", () => {
    assert.equal(buildMachineReport([taskResult({ taskId: "string-duration", durationMs: "100" })]).tasks[0].durationMs, 0);
  });
  await t.test("finite nonnegative numbers are preserved", () => {
    assert.equal(buildMachineReport([taskResult({ taskId: "good-duration", durationMs: 1.23 })]).tasks[0].durationMs, 1.23);
  });
});

test("serializeMachineReport re-normalizes hostile input", () => {
  const direct = {
    runId: "bad run\nwith newline",
    generatedAt: { now: true },
    tasks: [
      {
        taskId: "bad task",
        fixture: "bad fixture",
        status: "passed",
        startedAt: {},
        finishedAt: "bad-date",
        durationMs: { valueOf: () => { throw new Error("bad"); } },
        steps: [
          {
            index: 1,
            tool: "browser.weird",
            expect: { status: "bad" },
            status: "bad",
            passed: true,
            forbidden: { violated: false, matchCount: -1 },
            result: { kind: "screenshot", unknown: "x" },
            error: "not-an-object",
          },
        ],
      },
    ],
  };

  const serialized = serializeMachineReport(direct);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.runId, "run");
  assert.equal(parsed.generatedAt, new Date(0).toISOString());
  assert.equal(parsed.tasks[0].taskId, "task");
  assert.equal(parsed.tasks[0].fixture, "fixtures");
  assert.equal(parsed.tasks[0].steps[0].tool, "browser.session.start");
  assert.equal(parsed.tasks[0].steps[0].result.kind, "screenshot");
  assert.equal(parsed.tasks[0].steps[0].error.code, "runner_contract_invalid");

  assert.equal(JSON.parse(serializeMachineReport({
    tasks: [taskResult({
      taskId: "path-ok",
      fixture: "test/fixtures/app/index.html",
    })],
  })).tasks[0].fixture, "test/fixtures/app/index.html");

  assert.equal(buildMachineReport([taskResult({
    taskId: "bad-fixture-report",
    fixture: "test/../fixtures/app/index.html",
    steps: [],
  })]).tasks[0].fixture, "fixtures");
});

test("machine report clamps task and step counts", () => {
  const tasks = [];
  for (let index = 0; index < 300; index += 1) {
    const steps = [];
    for (let step = 0; step < 500; step += 1) {
      steps.push({
        index: step,
        tool: "browser.session.start",
        expect: { status: "completed" },
        status: "completed",
        passed: true,
        forbidden: { violated: false, matchCount: 0 },
      });
    }
    tasks.push(taskResult({ taskId: `bounded-${index}`, steps }));
  }

  const report = buildMachineReport(tasks);
  assert.equal(report.tasks.length <= 256, true);
  assert.equal(report.tasks.every((entry) => entry.steps.length <= 256), true);
});

test("fixture teardown runs without setup", async () => {
  const calls = [];
  const result = await replayTask(evalTask({ id: "teardown-no-setup" }), {
    runner: createRunner([{ status: "completed" }, { status: "completed" }]).fn,
    fixtureAdapter: {
      teardown: (_task, _context, meta) => calls.push(meta.status),
    },
  });

  assert.equal(result.status, "passed");
  assert.deepEqual(calls, ["passed"]);
});

test("fixture teardown runs when setup fails and preserves failure", async () => {
  const calls = [];
  const result = await replayTask(evalTask({ id: "setup-fails" }), {
    runner: createRunner([{ status: "completed" }]).fn,
    fixtureAdapter: {
      setup: () => {
        throw new Error("setup fail");
      },
      teardown: (_task, _context, meta) => calls.push(meta.status),
    },
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "setup_failed");
  assert.deepEqual(calls, ["failed"]);
});

test("fixtureResolveRef rejects all-empty semantic hints", () => {
  const resolution = fixtureResolveRef({
    previousObservation: {
      nodes: [{}, { ref: "x" }],
    },
    hint: {
      target: "",
      role: undefined,
    },
    task: {
      id: "bad",
    },
  });

  assert.equal(resolution.status, "runner_contract_invalid");
});

test("report summary remains deterministic for hostile duplicate indexes", () => {
  const report = buildMachineReport([
    taskResult({
      taskId: "dup-index",
      steps: [
        {
          index: 2,
          tool: "browser.act",
          expect: { status: "completed" },
          status: "completed",
          passed: false,
          forbidden: { violated: false, matchCount: 0 },
        },
        {
          index: 2,
          tool: "browser.act",
          expect: { status: "completed" },
          status: "not-started",
          passed: true,
          forbidden: { violated: false, matchCount: 0 },
        },
      ],
    }),
  ]);

  assert.deepEqual(report.tasks[0].steps.map((entry) => entry.index), [0, 2]);
  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.passed, 0);
});

test("report forbids markdown-sensitive task/status/result fields", () => {
  const sanitized = buildMachineReport([
    taskResult({
      taskId: "ok",
      status: "passed",
      steps: [
        {
          index: 0,
          tool: "browser.act",
          expect: { status: "completed" },
          status: "completed",
          reason: "a\n|b|c",
          passed: true,
          forbidden: { violated: false, matchCount: 0 },
          result: { kind: "ack", text: "leak" },
          error: { code: "runner_error" },
        },
      ],
    }),
  ], { runId: "good-run"});

  const markdown = renderMarkdownReport(sanitized);
  assert.equal(markdown.includes("a\n"), false);
  assert.equal(markdown.includes("|b|c"), false);
  assert.equal(markdown.includes("runner_error"), false);
});
