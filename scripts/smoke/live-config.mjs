export function resolveLiveBrowserFamily(env = process.env) {
  const value = env.NEWTON_BROWSER_QA_BROWSER ?? "chrome";
  if (value === "chrome" || value === "edge") return value;
  throw new Error("live browser family must be chrome or edge (set NEWTON_BROWSER_QA_BROWSER)");
}
