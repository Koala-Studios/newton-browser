import { EngineError, type EngineReceipt, type EngineObservation } from "./command-contract.ts";

/** The reader and final encoder share this exact escaped MCP result envelope. */
export function encodeEngineResult(value: unknown, maxBytes?: number) {
  let safe=value;
  let image: {type:'image';data:string;mimeType:string}|undefined;
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'observation' in value) {
    const record=value as Record<string,unknown>,observation=record.observation as EngineObservation;
    if(observation&&(observation.state==='available'||observation.state==='incomplete')) {
      const {imageData,...rest}=observation;
      safe={...record,observation:rest};
      if(typeof imageData==='string'&&typeof observation.mimeType==='string')image={type:'image',data:imageData,mimeType:observation.mimeType};
    }
  }
  const content: ({type:'text';text:string}|{type:'image';data:string;mimeType:string})[]=[...(image?[image]:[]),{type:'text',text:JSON.stringify(safe)}];
  const result={resultType:'complete' as const,content};
  if(maxBytes!==undefined&&Buffer.byteLength(JSON.stringify(result),'utf8')>maxBytes)throw new EngineError('output_budget');
  return result;
}

export interface EngineObservationBudget {
  readonly maxBytes: number;
  fits(observation: EngineObservation): boolean;
}
function observationBudget(maxBytes:number,envelope:Record<string,unknown>):EngineObservationBudget {
  return Object.freeze({maxBytes,fits:(observation:EngineObservation)=>Buffer.byteLength(JSON.stringify(encodeEngineResult({...envelope,observation})),'utf8')<=maxBytes});
}
export function readObservationBudget(maxBytes:number):EngineObservationBudget {
  return observationBudget(maxBytes,{nextCommandId:Number.MAX_SAFE_INTEGER});
}
export function receiptObservationBudget(maxBytes:number,envelope:Omit<EngineReceipt,'observation'>):EngineObservationBudget {
  return observationBudget(maxBytes,envelope);
}
export function asObservationBudget(value:number|EngineObservationBudget):EngineObservationBudget {
  return typeof value==='number'?readObservationBudget(value):value;
}

/** Mandatory receipts survive an unexpected optional-reader contract violation. */
export function encodeEngineReceipt(receipt: EngineReceipt, maxBytes: number) {
  let result = encodeEngineResult(receipt);
  // The reader must choose its output before allocating refs. Never silently drop published refs here.
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) {
    result = encodeEngineResult({ ...receipt, observation: { state: "unavailable", errorCode: "output_budget" } });
  }
  if (Buffer.byteLength(JSON.stringify(result)) > maxBytes) throw new EngineError("output_budget");
  return result;
}
