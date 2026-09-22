// GPL-3.0-or-later. CSV layout from data_export.py (Kevin O'Connor,
// Dmitry Butyugin). Numeric text uses shortest round-trip ECMAScript notation.
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import {open,rename,rm} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {motanScalarBytes,type MotanScalar,type MotanTable} from './table.ts';

export interface MotanCsvOptions {signal?:AbortSignal;maxOutputBytes?:number;}
const quote=(value:string)=>/[",\r\n]/.test(value)?'"'+value.replaceAll('"','""')+'"':value;
const numberText=(value:number)=>{
 if(!Number.isFinite(value))throw new Error('Motan CSV requires finite numeric values');
 return Object.is(value,-0)?'-0':String(value);
};
function scalarText(value:MotanScalar,structured:WeakMap<object,string>):string{
 motanScalarBytes(value);
 if(value!==null&&typeof value==='object'){
  const cached=structured.get(value);if(cached!==undefined)return cached;
  const text=quote(value.text);if(Object.isFrozen(value))structured.set(value,text);return text;
 }
 return value===null?'':typeof value==='boolean'?(value?'True':'False'):typeof value==='number'?numberText(value):quote(String(value));
}
/** Caller owns and must not mutate the numeric analysis until iteration finishes.
 * Column order and duplicates are preserved; only a chunk and one row are built. */
export async function* motanCsvChunks(analysis:MotanTable,columns:readonly string[],options:MotanCsvOptions={}):AsyncGenerator<Buffer>{
 const signal=options.signal,max=options.maxOutputBytes??256*1024**2;
 signal?.throwIfAborted();
 if(!Array.isArray(columns)||!columns.length||columns.length>256
    ||!Number.isSafeInteger(max)||max<1||max>1024**3
    ||!(analysis.times instanceof Float64Array)||analysis.times.length>2000000)
  throw new Error('Invalid Motan CSV limits or columns');
 const selected=columns.map(name=>{
  const label=analysis.labels[name],values=analysis.datasets[name];
  if(typeof name!=='string'||!Object.hasOwn(analysis.datasets,name)||!Object.hasOwn(analysis.labels,name)
     ||(!(values instanceof Float64Array)&&!Array.isArray(values))||values.length!==analysis.times.length
     ||!label||typeof label.label!=='string'||typeof label.units!=='string'
     ||label.label.length>16384||label.units.length>16384)
   throw new Error('Invalid Motan CSV column');
  const unit=label.units.split('\n').at(-1)!;
  return {values,heading:unit==='Unknown'?label.label:label.label+' '+unit};
 });
 let pending='',bytes=0;const structured=new WeakMap<object,string>();
 const append=(row:string)=>{bytes+=Buffer.byteLength(row);if(bytes>max)throw new Error('Motan CSV output limit');pending+=row;};
 append(['Time (s)',...selected.map(column=>column.heading)].map(quote).join(',')+'\r\n');
 if(pending.length>=65536){yield Buffer.from(pending);pending='';}
 for(let i=0;i<analysis.times.length;i++){
  signal?.throwIfAborted();
  append([numberText(analysis.times[i]),...selected.map(({values})=>scalarText(values[i],structured))].join(',')+'\r\n');
  if(pending.length>=65536){yield Buffer.from(pending);pending='';}
  if((i+1)%256===0){await yieldImmediate();signal?.throwIfAborted();}
 }
 signal?.throwIfAborted();if(pending)yield Buffer.from(pending);
}
/** Publish only a complete export. Existing output survives validation, I/O or
 * cancellation failure before rename. Atomic rename is not a power-loss fsync. */
export async function writeMotanCsv(analysis:MotanTable,columns:readonly string[],filename:string,options:MotanCsvOptions={}):Promise<void>{
 options.signal?.throwIfAborted();
 const temp=join(dirname(filename),`.${basename(filename)}.${randomUUID()}.tmp`);let owned=false;
 try{
  const file=await open(temp,'wx',0o600);owned=true;
  try{await file.writeFile(motanCsvChunks(analysis,columns,options),{signal:options.signal});}finally{await file.close();}
  options.signal?.throwIfAborted();await rename(temp,filename);
 }finally{if(owned)await rm(temp,{force:true});}
}
