import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_LIFECYCLE_STATES,
  MAX_CLEANUP_FAILURE_CODE_LENGTH,
  MAX_CLEANUP_FAILURE_MESSAGE_LENGTH,
  MAX_CLEANUP_STEP_NAME_LENGTH,
  MAX_CLEANUP_FAILURE_REPORTS,
  MAX_DEDUPE_KEY_LENGTH,
  runSessionTransaction,
} from "../src/session-transaction.js";

async function captureRejected(action) {
  let captured;
  try {
    await action();
  } catch (error) {
    captured = error;
  }
  if (captured == null) {
    assert.fail("expected promise to reject");
  }
  return captured;
}

test("captureRejected rejects when action resolves", async () => {
  await assert.rejects(() => captureRejected(() => Promise.resolve("ok")), (error) => {
    assert.equal(error.name, "AssertionError");
    assert.match(error.message, /expected promise to reject/);
    return true;
  });
});

test("runSessionTransaction returns successful work result without invoking rollback", async () => {
  const cleanups = [];
  const result = await runSessionTransaction(({ defer }) => {
    defer("owned-tab", () => cleanups.push("owned-tab"));
    return "done";
  });

  assert.equal(result, "done");
  assert.deepEqual(cleanups, []);
});

test("runSessionTransaction preserves primary Error identity, code, and rollback order", async () => {
  const cleanups = [];
  const primary = new Error("primary failed");
  primary.code = "E_PRIMARY";
  const error = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer("prepare", () => cleanups.push("prepare"));
      defer("attach", () => cleanups.push("attach"));
      defer("verify", () => cleanups.push("verify"));
      throw primary;
    }),
  );

  assert.strictEqual(error, primary);
  assert.equal(error.code, "E_PRIMARY");
  assert.deepEqual(cleanups, ["verify", "attach", "prepare"]);
  assert.equal(error.cleanup.attempts, 3);
  assert.equal(error.cleanup.completed, 3);
  assert.equal(error.cleanup.failureCount, 0);
  assert.equal(error.cleanup.failures.length, 0);
  assert.equal(error.cleanup.truncated, false);
});

test("runSessionTransaction executes rollback for every failure position", async () => {
  const stepCount = 4;
  for (let failAt = 0; failAt < stepCount; failAt += 1) {
    const cleanups = [];
    const expected = [];
    for (let step = failAt; step >= 0; step -= 1) {
      expected.push(`cleanup-${step}`);
    }

    const error = await captureRejected(() =>
      runSessionTransaction(({ defer }) => {
        for (let step = 0; step < stepCount; step += 1) {
          defer(`cleanup-${step}`, () => cleanups.push(`cleanup-${step}`));
          if (step === failAt) {
            throw new Error(`primary-failed-${failAt}`);
          }
        }
      }),
    );

    assert.deepEqual(cleanups, expected);
    assert.equal(error.message, `primary-failed-${failAt}`);
  }
});

test("runSessionTransaction allows repeated cleanup functions without dedupe by default", async () => {
  const cleanups = [];
  const shared = () => cleanups.push("shared");
  const error = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer("resource-a", shared);
      defer("resource-b", shared);
      throw new Error("primary with duplicate functions");
    }),
  );

  assert.deepEqual(cleanups, ["shared", "shared"]);
  assert.equal(error.cleanup.attempts, 2);
  assert.equal(error.cleanup.completed, 2);
});

test("runSessionTransaction supports explicit dedupe keys for cleanup callbacks", async () => {
  const cleanups = [];
  const shared = () => cleanups.push("shared");
  const registered = await runSessionTransaction(({ defer }) => {
    const first = defer("resource-a", shared, { dedupeKey: "A" });
    const second = defer("resource-b", shared, { dedupeKey: "A" });
    assert.equal(first, true);
    assert.equal(second, false);
    return { first, second };
  });

  assert.equal(registered.first, true);
  assert.equal(registered.second, false);
  assert.deepEqual(cleanups, []);
});

test("runSessionTransaction rejects invalid dedupe keys", async () => {
  const emptyObject = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer("resource", () => {}, { dedupeKey: {} });
      throw new Error("primary");
    }),
  );

  assert.match(emptyObject.message, /dedupeKey/);

  const emptyString = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer("resource", () => {}, { dedupeKey: "" });
      throw new Error("primary");
    }),
  );

  assert.match(emptyString.message, /dedupeKey/);

  const tooLong = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer("resource", () => {}, { dedupeKey: "x".repeat(MAX_DEDUPE_KEY_LENGTH + 1) });
      throw new Error("primary");
    }),
  );

  assert.match(tooLong.message, /dedupeKey/);
});

test("runSessionTransaction supports async work and async cleanup", async () => {
  const cleanups = [];
  const error = await captureRejected(() =>
    runSessionTransaction(async ({ defer }) => {
      defer("cleanup", async () => {
        await Promise.resolve();
        cleanups.push("cleanup");
      });
      await Promise.resolve();
      throw new Error("async primary");
    }),
  );

  assert.deepEqual(cleanups, ["cleanup"]);
  assert.equal(error.message, "async primary");
  assert.equal(error.cleanup.attempts, 1);
  assert.equal(error.cleanup.completed, 1);
});

test("runSessionTransaction rejects deferred cleanup registration after settlement and continues rollback", async () => {
  const cleanups = [];
  let capturedDefer;
  const error = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      capturedDefer = defer;
      defer("first", () => {
        cleanups.push("first");
      });
      defer("second", () => {
        cleanups.push("second");
        defer("late", () => {
          cleanups.push("late");
        });
        capturedDefer("late", () => {
          cleanups.push("late-outer");
        });
      });
      defer("third", () => {
        cleanups.push("third");
      });
      throw new Error("primary");
    }),
  );

  assert.deepEqual(cleanups, ["third", "second", "first"]);
  assert.equal(error.cleanup.failures.length, 1);
  assert.equal(error.cleanup.failures[0].step, "second");
  assert.equal(error.cleanup.failures[0].message, "session_transaction_settled");
});

test("runSessionTransaction captures and truncates cleanup failure metadata beyond the report limit", async () => {
  const failures = [];
  const callbackCount = MAX_CLEANUP_FAILURE_REPORTS + 4;
  const error = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      for (let index = 0; index < callbackCount; index += 1) {
        defer(`callback-${index}`, () => {
          failures.push(`callback-${index}`);
          throw new Error(`failure-${index}`);
        });
      }
      throw new Error("primary");
    }),
  );

  assert.equal(failures.length, callbackCount);
  assert.equal(error.cleanup.attempts, callbackCount);
  assert.equal(error.cleanup.completed, 0);
  assert.equal(error.cleanup.failureCount, callbackCount);
  assert.equal(error.cleanup.truncated, true);
  assert.equal(error.cleanup.failures.length, MAX_CLEANUP_FAILURE_REPORTS);
  assert.equal(error.cleanup.failures[0].step, `callback-${callbackCount - 1}`);
  assert.equal(error.cleanup.failures.at(-1).step, `callback-${callbackCount - 16}`);
});

test("runSessionTransaction bounds cleanup diagnostics for step, code, and message", async () => {
  const longMessage = "M".repeat(MAX_CLEANUP_FAILURE_MESSAGE_LENGTH + 20);
  const longStep = "S".repeat(MAX_CLEANUP_STEP_NAME_LENGTH + 20);
  const error = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer(longStep, () => {
        const err = new Error(longMessage);
        err.code = 99;
        throw err;
      });
      defer("bounded-code-obj", () => {
        const err = new Error("non-scalar code");
        err.code = { nested: true };
        throw err;
      });
      throw new Error("primary");
    }),
  );

  assert.equal(error.cleanup.failures.length, 2);
  assert.equal(error.cleanup.failures.some((entry) => entry.step.length === MAX_CLEANUP_STEP_NAME_LENGTH), true);
  assert.ok(error.cleanup.failures.some((entry) => entry.step === "bounded-code-obj"));
  assert.ok(error.cleanup.failures.some((entry) => entry.message.length === MAX_CLEANUP_FAILURE_MESSAGE_LENGTH));
  const boundedCodeEntries = error.cleanup.failures.filter((entry) => entry.code === "99");
  const scalarFilteredEntries = error.cleanup.failures.filter((entry) => entry.code === undefined);
  assert.equal(boundedCodeEntries.length, 1);
  assert.equal(scalarFilteredEntries.length, 1);
});

test("runSessionTransaction handles cleanup diagnostics that throw during conversion", async () => {
  const cleanups = [];
  const primary = new Error("hostile cleanup");
  const hostileStep = {
    toString() {
      throw new Error("hostile step name conversion");
    },
  };
  const hostileError = {};
  Object.defineProperty(hostileError, "code", {
    get() {
      throw new Error("hostile code conversion");
    },
  });
  Object.defineProperty(hostileError, "message", {
    get() {
      throw new Error("hostile message conversion");
    },
  });
  Object.defineProperty(hostileError, "name", {
    get() {
      throw new Error("hostile name conversion");
    },
  });

  const error = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer(hostileStep, () => {
        cleanups.push("hostile");
        throw hostileError;
      });
      defer("safe", () => {
        cleanups.push("safe");
      });
      throw primary;
    }),
  );

  assert.strictEqual(error, primary);
  assert.deepEqual(cleanups, ["safe", "hostile"]);
  assert.equal(error.cleanup.failures.length, 1);
  assert.equal(typeof error.cleanup.failures[0].step, "string");
  assert.equal(typeof error.cleanup.failures[0].message, "string");
});

test("runSessionTransaction converts non-Error throws and still executes rollback", async () => {
  const cleanups = [];
  const error = await captureRejected(() =>
    runSessionTransaction(({ defer }) => {
      defer("cleanup", () => cleanups.push("cleanup"));
      throw "string failure";
    }),
  );

  assert.ok(error instanceof Error);
  assert.equal(error.message, "string failure");
  assert.deepEqual(cleanups, ["cleanup"]);
});

test("runSessionTransaction supports explicit lifecycle API without destructured state", async () => {
  const calls = [];
  const error = await captureRejected(() =>
    runSessionTransaction(({ lifecycle }) => {
      calls.push(`state:${lifecycle.getState()}`);
      lifecycle.transition("creating_tab");
      calls.push(`state:${lifecycle.getState()}`);
      lifecycle.transition("attaching_debugger");
      calls.push(`state:${lifecycle.getState()}`);
      throw new Error("lifecycle-failed");
    }, {
      lifecycle: {
        states: DEFAULT_LIFECYCLE_STATES,
      },
    }),
  );

  assert.deepEqual(calls, [
    "state:creating_host",
    "state:creating_tab",
    "state:attaching_debugger",
  ]);
  assert.equal(error.message, "lifecycle-failed");
});

test("runSessionTransaction validates invalid lifecycle transitions and records rollback metadata", async () => {
  const error = await captureRejected(() =>
    runSessionTransaction(({ lifecycle }) => {
      lifecycle.transition("stopped");
      return "ok";
    }, {
      lifecycle: {
        states: DEFAULT_LIFECYCLE_STATES,
      },
    }),
  );

  assert.match(error.message, /^invalid_lifecycle_transition:/);
  assert.equal(error.cleanup.attempts, 0);
  assert.equal(error.cleanup.completed, 0);
  assert.equal(error.cleanup.failureCount, 0);
});

test("runSessionTransaction validates explicit lifecycle configuration", async () => {
  const explicitEmpty = await captureRejected(() =>
    runSessionTransaction(() => "ok", {
      lifecycle: {
        states: [],
      },
    }),
  );
  assert.match(explicitEmpty.message, /lifecycle states must be a non-empty array/);

  const duplicate = await captureRejected(() =>
    runSessionTransaction(() => "ok", {
      lifecycle: {
        states: ["a", "a"],
      },
    }),
  );
  assert.match(duplicate.message, /duplicate lifecycle state: a/);

  const invalidInitial = await captureRejected(() =>
    runSessionTransaction(() => "ok", {
      lifecycle: {
        states: ["a", "b"],
        initialState: "c",
      },
    }),
  );
  assert.match(invalidInitial.message, /unknown lifecycle initial state: c/);

  const invalidTransitions = await captureRejected(() =>
    runSessionTransaction(() => "ok", {
      lifecycle: {
        states: ["a", "b"],
        transitions: {
          a: ["c"],
        },
      },
    }),
  );
  assert.match(invalidTransitions.message, /unknown lifecycle transition target: c/);
});
