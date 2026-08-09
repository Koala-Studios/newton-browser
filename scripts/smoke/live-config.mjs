const FIRST_HOST_PORT = 17_321;
const LAST_HOST_PORT = 17_340;

export function resolveLiveBrowserTarget(env = process.env) {
  const value = env.NEWTON_BROWSER_QA_OWNER ?? env.NEWTON_BROWSER_BROWSER ?? "chrome";
  if (value === "chrome" || value === "edge") return value;
  throw new Error("live browser target must be chrome or edge (set NEWTON_BROWSER_QA_OWNER)");
}

export function resolveLiveHostPort(env = process.env) {
  const value = env.NEWTON_BROWSER_PORT;
  if (value === undefined || String(value).trim() === "") return undefined;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < FIRST_HOST_PORT || port > LAST_HOST_PORT) {
    throw new Error(`NEWTON_BROWSER_PORT must be an integer from ${FIRST_HOST_PORT} through ${LAST_HOST_PORT}`);
  }
  return port;
}
