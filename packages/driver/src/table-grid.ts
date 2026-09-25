/** Pure table-model foundation. Every occupied slot points to one source cell;
 * text and links are never duplicated to manufacture a rectangular dataset.
 */
export interface TableSourceCell {
  id: string;
  domId?: string;
  header: boolean;
  scope?: 'row'|'col'|'rowgroup'|'colgroup'|'auto';
  explicitHeaders?: readonly string[];
  rowSpan: number;
  colSpan: number;
  text: string;
  links?: readonly {label:string;href:string}[];
}
export interface TableSourceRow {id:string;groupId:string;cells:readonly TableSourceCell[];}
export interface TableGridCell extends TableSourceCell {
  row:number;column:number;effectiveRowSpan:number;
  headerIds:readonly string[];headersUnresolved:boolean;
}
export type TableGrid = {
  state:'available';columns:number;
  rows:readonly {id:string;groupId:string;slots:readonly (string|null)[]}[];
  cells:readonly TableGridCell[];
} | {state:'unsupported';reason:'work_limit'|'duplicate_identity'|'invalid_span'|'overlap'|'row_group_crossing';};

const MAX_ROWS=128,MAX_COLUMNS=64,MAX_SLOTS=8192,MAX_CELLS=2048;

export function buildTableGrid(source:readonly TableSourceRow[]):TableGrid {
  if(source.length>MAX_ROWS)return {state:'unsupported',reason:'work_limit'};
  const rowIds=new Set<string>(),cellIds=new Set<string>(),groups=new Set<string>();
  const groupEnd:number[]=[];
  for(let start=0;start<source.length;){
    const group=source[start]!.groupId;
    if(groups.has(group))return {state:'unsupported',reason:'duplicate_identity'};
    groups.add(group);let end=start+1;
    while(end<source.length&&source[end]!.groupId===group)end++;
    for(let row=start;row<end;row++)groupEnd[row]=end;
    start=end;
  }
  const slots:(string|null)[][]=source.map(()=>[]),cells:TableGridCell[]=[];
  let columns=0;
  for(let row=0;row<source.length;row++){
    const input=source[row]!;
    if(!input.id||rowIds.has(input.id))return {state:'unsupported',reason:'duplicate_identity'};
    rowIds.add(input.id);let column=0;
    for(const cell of input.cells){
      if(cells.length>=MAX_CELLS)return {state:'unsupported',reason:'work_limit'};
      if(!cell.id||cellIds.has(cell.id))return {state:'unsupported',reason:'duplicate_identity'};
      cellIds.add(cell.id);
      if(!Number.isSafeInteger(cell.rowSpan)||cell.rowSpan<0||!Number.isSafeInteger(cell.colSpan)||cell.colSpan<1)return {state:'unsupported',reason:'invalid_span'};
      const height=cell.rowSpan===0?groupEnd[row]!-row:cell.rowSpan;
      if(row+height>groupEnd[row]!)return {state:'unsupported',reason:'row_group_crossing'};
      while(slots[row]![column])column++;
      const endColumn=column+cell.colSpan;
      if(endColumn>MAX_COLUMNS||source.length*endColumn>MAX_SLOTS)return {state:'unsupported',reason:'work_limit'};
      for(let r=row;r<row+height;r++)for(let c=column;c<endColumn;c++){
        if(slots[r]![c])return {state:'unsupported',reason:'overlap'};
        slots[r]![c]=cell.id;
      }
      cells.push({...cell,row,column,effectiveRowSpan:height,headerIds:[],headersUnresolved:false});
      column=endColumn;columns=Math.max(columns,column);
    }
  }
  const byDomId=new Map<string,TableGridCell[]>();
  for(const cell of cells)if(cell.domId){const entries=byDomId.get(cell.domId)??[];entries.push(cell);byDomId.set(cell.domId,entries);}
  const headers=cells.filter(cell=>cell.header);
  const overlap=(start:number,length:number,other:number,otherLength:number)=>start<other+otherLength&&other<start+length;
  for(const cell of cells){
    const ids:string[]=[],seenHeaders=new Set<string>();let unresolved=false;
    if(cell.explicitHeaders!==undefined){
      if(cell.explicitHeaders.length>MAX_CELLS)return {state:'unsupported',reason:'work_limit'};
      for(const domId of cell.explicitHeaders){
        const matches=byDomId.get(domId);
        if(matches?.length!==1||!matches[0]!.header){unresolved=true;continue;}
        if(matches[0]!.id===cell.id){unresolved=true;continue;}
        if(matches[0]!.id!==cell.id&&!seenHeaders.has(matches[0]!.id)){ids.push(matches[0]!.id);seenHeaders.add(matches[0]!.id);}
      }
    }else{
      for(const header of headers){
        if(header.id===cell.id)continue;
        const sameGroup=source[header.row]!.groupId===source[cell.row]!.groupId;
        const rowOverlap=overlap(header.row,header.effectiveRowSpan,cell.row,cell.effectiveRowSpan);
        const colOverlap=overlap(header.column,header.colSpan,cell.column,cell.colSpan);
        if((header.scope==='row'&&sameGroup&&rowOverlap)||(header.scope==='rowgroup'&&sameGroup)||(header.scope==='col'&&colOverlap))ids.push(header.id);
        else if((header.scope==='colgroup'&&colOverlap)||((!header.scope||header.scope==='auto')&&(rowOverlap||colOverlap)))unresolved=true;
      }
    }
    cell.headerIds=ids;cell.headersUnresolved=unresolved;
  }
  return {state:'available',columns,cells,rows:source.map((row,index)=>({id:row.id,groupId:row.groupId,slots:Array.from({length:columns},(_,column)=>slots[index]![column]??null)}))};
}
