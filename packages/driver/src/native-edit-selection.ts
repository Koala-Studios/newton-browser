import {EngineError} from '@newton-browser/core';

/** A single bounded native editing event selects without touching text. Use the
 * nearer document edge to avoid walking a long prefix for a short suffix edit.
 * Chromium's actual selection must still be checked before inserting anything. */
export function nativeSelectionCommands(value:string,start:number,end:number):readonly string[]{
  if(value.length>65536)throw new EngineError('work_limit');
  const boundaries=[...new Intl.Segmenter('en',{granularity:'grapheme'}).segment(value)].map(item=>item.index);
  boundaries.push(value.length);
  const from=boundaries.indexOf(start),to=boundaries.indexOf(end);
  if(from<0||to<from)throw new EngineError('unsupported_structure');
  const after=boundaries.length-1-to,count=to-from;
  if(Math.min(from,after)+count+1>4096)throw new EngineError('work_limit');
  return Object.freeze(from<=after
    ?['moveToBeginningOfDocument',...Array<string>(from).fill('moveForward'),...Array<string>(count).fill('moveForwardAndModifySelection')]
    :['moveToEndOfDocument',...Array<string>(after).fill('moveBackward'),...Array<string>(count).fill('moveBackwardAndModifySelection')]);
}

// Read-only isolated-world range measurement. Detached Range objects never
// change the document or selection. Only exact offsets inside this field count.
export const EDIT_SELECTION_READ=`function(expected){
  const type=(this.getAttribute('type')||'').toLowerCase(),autocomplete=(this.getAttribute('autocomplete')||'').toLowerCase();
  if(type==='password'||/password|one-time-code|cc-|webauthn/.test(autocomplete))return {};
  let root=this,depth=0;while(root.parentNode&&depth++<256)root=root.parentNode;
  const valid=!root.parentNode&&root.activeElement===this&&this.isConnected&&!this.disabled&&!this.readOnly&&(typeof this.value==='string'?this.value:this.textContent)===expected;
  if(!valid)return {valid:false};
  if(typeof this.selectionStart==='number')return {valid:true,start:this.selectionStart,end:this.selectionEnd};
  if(!this.isContentEditable)return {};
  const selection=this.ownerDocument.getSelection();
  if(!selection||selection.rangeCount!==1)return {};
  const range=selection.getRangeAt(0);
  if(!this.contains(range.startContainer)||!this.contains(range.endContainer))return {};
  const prefix=this.ownerDocument.createRange();prefix.selectNodeContents(this);prefix.setEnd(range.startContainer,range.startOffset);
  const start=prefix.toString().length;
  return {valid:true,start,end:start+range.toString().length};
}`;
