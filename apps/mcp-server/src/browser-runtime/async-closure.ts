import { readProcessTable } from "./process-table.ts";
import { createIdentityLeaseClosureVerifier } from "./identity-lease-closure.ts";
import { createProfileSourceClosureVerifier } from "./profile-closure.ts";

export async function freshIdentityClosureVerifier(browserFamily: "chrome" | "edge", signal?: AbortSignal) {
  const table = await readProcessTable({ ownership: true, ...(signal ? { signal } : {}) });
  return createIdentityLeaseClosureVerifier({ browserFamily, processListProvider: () => table });
}
export async function freshExternalProfileClosureVerifier(browserFamily: "chrome" | "edge", signal?: AbortSignal) {
  const table = await readProcessTable({ ownership: false, ...(signal ? { signal } : {}) });
  return createProfileSourceClosureVerifier({ browserFamily, processListProvider: () => table });
}
