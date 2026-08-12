export async function waitForLiveSessionMarker(bridge, sessions, {
  marker = "fixture-ready",
  timeoutMs = 30_000,
} = {}) {
  if (!bridge || typeof bridge.dispatch !== "function") throw new Error("live bridge dispatch is required");
  if (!Array.isArray(sessions) || sessions.length === 0) throw new Error("at least one live session is required");
  if (typeof marker !== "string" || !marker.trim()) throw new Error("live readiness marker is required");

  return Promise.all(sessions.map(async (session) => {
    const result = await bridge.dispatch(session.sessionId, {
      kind: "wait_for",
      waitFor: { text: marker },
      timeoutMs,
    }, timeoutMs + 5_000);
    if (result?.ok !== true || result.result?.actionStatus !== "verified") {
      const summary = {
        ok: result?.ok === true,
        errorCode: typeof result?.errorCode === "string" ? result.errorCode.slice(0, 80) : null,
        actionStatus: typeof result?.result?.actionStatus === "string" ? result.result.actionStatus.slice(0, 40) : null,
        sequence: Number.isSafeInteger(result?.sequence) ? result.sequence : null,
      };
      throw new Error(`session ${session.sessionId} did not reach ${marker}: ${JSON.stringify(summary)}`);
    }
    return { sessionId: session.sessionId, sequence: result.sequence };
  }));
}

export async function waitForHostSentCount(bridge, expected, { timeoutMs = 5_000 } = {}) {
  if (!bridge || typeof bridge.getStatus !== "function") throw new Error("live bridge status is required");
  if (!Number.isSafeInteger(expected) || expected < 1) throw new Error("expected sent count must be a positive safe integer");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const sent = bridge.getStatus()?.commandMetrics?.sent;
    if (Number.isSafeInteger(sent) && sent >= expected) return sent;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`host did not send command ${expected} within ${timeoutMs}ms`);
}
