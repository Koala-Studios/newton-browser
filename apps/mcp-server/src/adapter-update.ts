/** Installation mechanics are injected; this coordinator owns the update/rollback state machine. */
export interface AdapterInstallation {
  validateBuild(digest: string): Promise<void>;
  currentDigest(): Promise<string>;
  quiesce(): Promise<void>;
  publish(digest: string): Promise<void>;
  reload(): Promise<void>;
  waitBootstrap(digest: string): Promise<{ digest: string; epoch: string; protocolMajor: number }>;
  smoke(): Promise<void>;
}
export async function verifyAdapterBootstrap(installation:AdapterInstallation,expected:string):Promise<void>{
  // Reload can disconnect before its acknowledgement. Only the new bootstrap and
  // fresh claim/DOM smoke establish success; no website input is replayed.
  await installation.reload().catch(()=>undefined);
  const hello=await installation.waitBootstrap(expected);
  if(hello.digest!==expected||hello.protocolMajor!==1||!hello.epoch)throw new Error('bootstrap_mismatch');
  await installation.smoke();
}
export async function updateAdapter(installation: AdapterInstallation, digest: string): Promise<{ state: "updated" | "rolled_back"; digest: string }> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("invalid_build_digest");
  await installation.validateBuild(digest);
  const previous = await installation.currentDigest();
  await installation.quiesce();
  const boot = (expected:string)=>verifyAdapterBootstrap(installation,expected);
  try { await installation.publish(digest); await boot(digest); return { state: "updated", digest }; }
  catch (updateError) {
    try { await installation.publish(previous); await boot(previous); return { state: "rolled_back", digest: previous }; }
    catch (rollbackError) { throw new Error("adapter_bootstrap_recovery_required",{cause:new AggregateError([updateError,rollbackError],'adapter_update_and_rollback_failed')}); }
  }
}
