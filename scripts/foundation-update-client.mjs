// Disposable QA process: execute the packed transaction up to its real reload
// boundary, then let the parent terminate this exact process without cleanup.
const [candidate,directory,staged,connections,advertisement,instanceId,tab]=process.argv.slice(2);
const {updateInstalledAdapter,developmentUpdateControl}=await import(candidate);
try{
  await updateInstalledAdapter(directory,staged,async({ticket,signal,bindingRequired})=>{
    const control=await developmentUpdateControl({directory:connections,advertisement,instanceId,ticket,smokeTabId:Number(tab),signal,bindingRequired});
    return {...control,reload:async()=>{
      await new Promise((resolve,reject)=>process.send({type:'published'},error=>error?reject(error):resolve()));
      await new Promise(()=>{});
    }};
  });
  throw new Error('kill_boundary_not_reached');
}catch(error){process.send?.({type:'error',message:error.message},()=>process.exit(1));}
