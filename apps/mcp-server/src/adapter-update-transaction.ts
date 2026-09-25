import {readAdapterDirectory,readAdapterUpdateDirectory,commitAdapterWorker} from './adapter-directory.ts';
import {adapterCodeInstallation,readAdapterBuilds,type AdapterControl} from './adapter-installation.ts';
import {openUpdateJournal,type UpdateJournal} from './adapter-update-journal.ts';
import {updateAdapter,verifyAdapterBootstrap,type AdapterInstallation} from './adapter-update.ts';

type Control=AdapterControl&{finish():Promise<void>;close():void};
export type UpdateControlFactory=(options:{ticket:string;signal:AbortSignal;recovering:boolean;bindingRequired:boolean})=>Promise<Control>;
type Result={state:'updated'|'rolled_back'|'already_committed'|'no_update';digest?:string;cleanupPending?:boolean};

/** The sole durable update owner. Control creation cannot mutate the browser until
 * the ticket and rollback code are persisted under installation-wide ownership. */
export async function updateInstalledAdapter(directory:string,staged:string,connect:UpdateControlFactory):Promise<Result>{
  const journal=await openUpdateJournal(directory);let control:Control|undefined;
  try{
    if(journal.read()&&journal.read()!.phase!=='committed')throw new Error('adapter_update_recovery_required');
    const installed=await readAdapterDirectory(directory);
    const builds=await readAdapterBuilds(directory,staged);
    const prior=journal.read();
    if(prior){
      // Preserve the last ticket until cleanup succeeds. Otherwise a crash after
      // commit could strand an old marker behind a newly overwritten journal.
      control=await connect({ticket:prior.ticket,signal:journal.signal,recovering:true,bindingRequired:false});
      await control.finish();control.close();control=undefined;
    }
    const record=await journal.begin(installed.installationId,builds.oldCode,builds.newCode);
    control=await connect({ticket:record.ticket,signal:journal.signal,recovering:false,bindingRequired:false});
    const installation=journaledInstallation(directory,record,journal,control);
    const result=await updateAdapter(installation,record.next);
    await commitAdapterWorker(directory,record,result.digest,journal.assertOwned);
    await journal.transition('committed',result.digest);
    let cleanupPending=false;try{await control.finish();}catch{cleanupPending=true;}
    return {...result,...(cleanupPending?{cleanupPending}: {})};
  }finally{control?.close();await journal.close();}
}

/** Recover conservatively to the recorded previous build. A historical committed
 * update is never replayed merely because its marker or original peer is gone. */
export async function recoverInstalledAdapter(directory:string,connect:UpdateControlFactory):Promise<Result>{
  const journal=await openUpdateJournal(directory);let control:Control|undefined;
  try{
    const record=journal.read();if(!record)return {state:'no_update'};
    if(record.phase==='committed'){
      const installed=await readAdapterDirectory(directory);
      if(installed.installationId!==record.installationId||installed.files['worker.js']!==record.target)throw new Error('adapter_installation_changed');
      // Cleanup is optional after the durable commit; no reload, claim or input.
      let cleanupPending=false;
      try{control=await connect({ticket:record.ticket,signal:journal.signal,recovering:true,bindingRequired:false});await control.finish();}catch{cleanupPending=true;}
      return {state:'already_committed',digest:record.target,...(cleanupPending?{cleanupPending}: {})};
    }
    await readAdapterUpdateDirectory(directory,record);
    control=await connect({ticket:record.ticket,signal:journal.signal,recovering:true,bindingRequired:record.phase!=='prepared'});
    const installation=journaledInstallation(directory,record,journal,control);
    await installation.quiesce();
    await installation.publish(record.previous);
    await verifyAdapterBootstrap(installation,record.previous);
    await commitAdapterWorker(directory,record,record.previous,journal.assertOwned);
    await journal.transition('committed',record.previous);
    let cleanupPending=false;try{await control.finish();}catch{cleanupPending=true;}
    return {state:'rolled_back',digest:record.previous,...(cleanupPending?{cleanupPending}: {})};
  }finally{control?.close();await journal.close();}
}

function journaledInstallation(directory:string,record:UpdateJournal,journal:Awaited<ReturnType<typeof openUpdateJournal>>,control:Control):AdapterInstallation{
  const code=adapterCodeInstallation(directory,Buffer.from(record.previousCode,'base64'),Buffer.from(record.nextCode,'base64'),control);
  let epoch:string|undefined;
  return {
    ...code,
    async currentDigest(){await readAdapterUpdateDirectory(directory,record);return record.previous;},
    async publish(target){
      await journal.assertOwned();await readAdapterUpdateDirectory(directory,record);
      await journal.transition('publishing',target);epoch=undefined;
      await journal.assertOwned();await code.publish(target);
      await journal.transition('published',target);
    },
    async waitBootstrap(target){const hello=await control.waitBootstrap(target);epoch=hello.epoch;return hello;},
    async smoke(){
      await control.smoke();await journal.assertOwned();
      if(!epoch)throw new Error('bootstrap_mismatch');
      await journal.transition('verified',journal.read()!.target,epoch);
    },
  };
}
