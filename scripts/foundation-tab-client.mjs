const { createDefaultEngineHost, handleMcpMessage } = await import(process.env.NEWTON_ENGINE_CANDIDATE_ENTRY ?? new URL('../apps/mcp-server/src/engine-candidate.ts',import.meta.url).href);
const [advertisement, tabId, instanceId] = process.argv.slice(2);
const host = createDefaultEngineHost({...process.env,NEWTON_BROWSER_CONFIG_DIR:process.env.NEWTON_TAB_QA_CONFIG_ROOT,NEWTON_BROWSER_NATIVE_ADVERTISEMENT:undefined});
let id = 0;
async function call(name, args) {
  const result = await handleMcpMessage(host, { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: {
    _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} }, name, arguments: args,
  } });
  if (result.error || result.result.isError) throw new Error(JSON.stringify(result));
  const text=result.result.content.find(block=>block.type==='text');
  if(!text)throw Error('missing_result_text');
  const parsed=JSON.parse(text.text);
  if(name==='browser.screenshot'){
    const image=result.result.content.find(block=>block.type==='image');
    if(image?.mimeType!=='image/png'||!Buffer.from(image.data,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error(JSON.stringify({failure:'missing_png_image',result:parsed}));
    parsed.imageBytes=Buffer.from(image.data,'base64').length;
    parsed.imageHeight=Buffer.from(image.data,'base64').readUInt32BE(20);
  }
  return parsed;
}
try {
  const discovered=await call('browser.existing.discover',{});
  if(!discovered.available||discovered.instanceId!==instanceId||!discovered.tabs.some(tab=>tab.tabId===Number(tabId)&&!tab.claimed))throw Error('discovery_missing_requested_tab');
  const initial = await call('browser.session.start', { mode: 'existing', target: { kind: 'tab', tabId: Number(tabId), instanceId } });
  const setup=await call('browser.existing.setup',{});
  if(setup.state!=='ready'||!setup.tabs.some(tab=>tab.tabId===Number(tabId)&&tab.claimed))throw Error('discovery_missing_claim');
  process.send({ type: 'ready', initial,discovered,setup });
  process.on('message', async message => {
    try {
      if (message.type === 'fill') {
        const ref = initial.observation.nodes.find(node => ['textbox', 'searchbox'].includes(node.role)&&node.name==='Draft')?.ref;
        if(!ref)throw Error(JSON.stringify({failure:'initial_draft_missing',observation:initial.observation}));
        const receipt = await call('browser.act', { sessionId: initial.sessionId, command: { commandId: 1, action: { kind: 'fill', target: { kind: 'ref', ref }, value: message.value } } });
        process.send({ type: 'filled', receipt });
      } else if(message.type==='create-tab'){
        const created=await call('browser.session.start',{mode:'existing',connectionId:discovered.connectionId,target:{kind:'new_tab',instanceId,url:message.url}});
        const receipt=await call('browser.act',{sessionId:created.sessionId,command:{commandId:1,action:{kind:'fill',target:{kind:'selector',selector:'#draft'},value:`created-by-${tabId}`}}});
        if(receipt.reason!=='completed')throw Error(JSON.stringify(receipt));
        const typed=await call('browser.act',{sessionId:created.sessionId,command:{commandId:2,action:{kind:'press',text:'-typed'}}});
        if(typed.reason!=='completed'||typed.dispatch!=='acknowledged')throw Error(JSON.stringify(typed));
        process.send({type:'created-tab',created,receipt,typed});
      } else if (message.type === 'probe') {
        let commandId=2;
        const act=async(action,pageId)=>{const receipt=await call('browser.act',{sessionId:initial.sessionId,command:{commandId:commandId++,timeoutMs:2500,action,...(pageId?{pageId}:{})}});if(receipt.reason!=='completed')throw new Error(JSON.stringify({action:action.kind,receipt}));return receipt;};
        const hover=await act({kind:'hover',target:{kind:'selector',selector:'#hover'},waitFor:{text:'hovered',timeoutMs:500}});
        const checkbox=await act({kind:'click',target:{kind:'selector',selector:'#toggle'},waitFor:{selector:'#toggle',state:'checked',timeoutMs:500}});
        const screenshot=await call('browser.screenshot',{sessionId:initial.sessionId,maxBytes:65536,timeoutMs:5000});
        const fullPageScreenshot=await call('browser.screenshot',{sessionId:initial.sessionId,fullPage:true,timeoutMs:5000});
        const opened=await act({kind:'click',target:{kind:'selector',selector:'#prompt'}});
        const accepted=await act({kind:'dialog_accept',dialogId:opened.observation.dialog.dialogId,promptText:'adapter-answer'});
        const scrolled=await act({kind:'scroll',target:{kind:'selector',selector:'#scrollbox'},x:0,y:100});
        const offscreen=await act({kind:'click',target:{kind:'selector',selector:'#far'},waitFor:{text:'Far clicked trusted=true',timeoutMs:500}});
        const files=await act({kind:'set_files',target:{kind:'selector',selector:'#media'},files:[message.uploadFile]});
        const document=await call('browser.document.read',{sessionId:initial.sessionId,maxBytes:8192});
        const records=await call('browser.observe',{sessionId:initial.sessionId,mode:'records',maxBytes:8192});
        const scopedControls=await call('browser.observe',{sessionId:initial.sessionId,scope:{kind:'selector',selector:'#frame-scope'},maxBytes:8192});
        const frameRef=scopedControls.observation.nodes?.find(node=>node.name==='Frame draft')?.ref;
        if(!frameRef)throw Error(JSON.stringify({failure:'scoped_frame_control_missing',scopedControls}));
        const frameFill=await act({kind:'fill',target:{kind:'ref',ref:frameRef},value:`frame-of-${tabId}`});
        const scopedDocument=await call('browser.document.read',{sessionId:initial.sessionId,scope:{kind:'selector',selector:'#frame-scope'},maxBytes:8192});
        const frameRemoved=await act({kind:'click',target:{kind:'selector',selector:'#remove-frame'},waitFor:{text:'Frame removed',timeoutMs:500}});
        const popup=await act({kind:'click',target:{kind:'selector',selector:'#popup'}});
        const child=popup.observation.newPages?.find(page=>page.openerPageId===popup.page.pageId);
        if(!child)throw new Error(JSON.stringify({failure:'popup_feedback_missing',popup}));
        // Follow the popup directly from the action receipt. The later list is a
        // QA ownership/selection cross-check, not a prerequisite for the edit.
        const childFill=await act({kind:'fill',target:{kind:'selector',selector:'#draft'},value:`child-of-${tabId}`},child.pageId);
        const pages=await call('browser.pages.list',{sessionId:initial.sessionId});
        if(!pages.pages.some(page=>page.pageId===child.pageId))throw new Error(JSON.stringify({failure:'owned_popup_missing',pages}));
        const childDocument=await call('browser.document.read',{sessionId:initial.sessionId,pageId:child.pageId,maxBytes:8192});
        const pending=message.leaveModal?await act({kind:'click',target:{kind:'selector',selector:'#prompt'}}):undefined;
        process.send({type:'probed',hover,checkbox,screenshot,fullPageScreenshot,opened,accepted,scrolled,offscreen,files,document,records,scopedControls,frameFill,scopedDocument,frameRemoved,popup,pages,child,childFill,childDocument,pending});
      } else if (message.type === 'stop') { await host.close(); process.send({ type: 'stopped' }); process.disconnect(); }
    } catch (error) { process.send({ type: 'error', message: error.message,nativeTrace }); }
  });
} catch (error) { process.send({ type: 'error', message: error.message }); await host.close(); process.disconnect(); }
import {channel} from 'node:diagnostics_channel';
const nativeTrace=[];
channel('newton-browser.native-command').subscribe(event=>{nativeTrace.push(event);if(nativeTrace.length>256)nativeTrace.shift();});
