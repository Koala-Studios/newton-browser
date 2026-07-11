export function stressTimeoutMs(env = process.env) {
  const durationMs = Number(env.NEWTON_BROWSER_STRESS_MS ?? 300_000);
  const warmupMs = Number(env.NEWTON_BROWSER_STRESS_WARMUP_MS ?? 30_000);
  return Math.max(120_000, durationMs + warmupMs + 30_000);
}
