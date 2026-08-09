export function waitForMcpResponse({
  requestId,
  responses,
  waiters,
  timeoutMs,
  diagnostics,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
}) {
  if (responses.has(requestId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = scheduleTimeout(() => {
      waiters.delete(requestId);
      reject(new Error(`MCP response timeout: ${diagnostics()}`));
    }, timeoutMs);
    const settle = () => {
      cancelTimeout(timer);
      waiters.delete(requestId);
      resolve();
    };
    waiters.set(requestId, settle);
    // Close the response-arrived-before-registration race.
    if (responses.has(requestId)) settle();
  });
}
