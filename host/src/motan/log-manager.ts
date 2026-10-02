import {cloneMotanJson,mergeMotanObjects,copyMotanStatusRoot} from './number-types.ts';
// GPL-3.0-or-later. From readlog.py, copyright (C) 2021 Kevin O'Connor.
import {MotanLogReader,type MotanReadOptions} from './log-reader.ts';
import {MotanDispatcher,MotanStatusTracker,motanObject,type DispatchOptions} from './dispatch.ts';
import {encodeMotanJson} from './capture.ts';
import {MotanStepSampler,MotanTrapSampler,type StepBlock,type TrapMove,type TrapSelection} from './motion-samples.ts';
import {MotanSensorSampler,motanAngleScale,type SensorBlock,type SensorSelection} from './sensor-samples.ts';
import {MotanPhaseSampler,motanPhaseConfig} from './phase-samples.ts';
import {MotanTypedPhaseSampler,motanTypedPhaseConfig} from './typed-phase-samples.ts';
import {MotanStallguardSampler,MotanStatusFieldSampler,type MotanStallguardRow} from './diagnostic-samples.ts';
import {parsePythonFloat} from '../moonraker/config-reader.ts';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import {motanScalarBytes,motanStructuredCell,type MotanStructuredCell,type MotanScalar} from './table.ts';
import {motanPythonRepr} from './python-repr.ts';
export const motanDatasetTypes=Object.freeze(['accelerometer','adxl345','angle','ldc1612','loadcell','stallguard','status','step_phase','stepq','trapq']);
export interface DatasetLabel {name:string;label:string;units:string;}
export interface MotanManagerOptions {start?:number;reader?:MotanReadOptions;dispatch?:DispatchOptions;maxIndexEntries?:number;}
export function splitMotanParameters(text:string):string[]{
 if(text.length>4096)throw new Error('Motan dataset expression too long');const result:string[]=[];let level=0,start=0;for(let i=0;i<text.length;i++){const c=text[i];if(c==='('){if(++level>64)throw new Error('Motan dataset nesting limit');}else if(c===')'){if(--level<0)throw new Error('Unbalanced Motan dataset');}else if(c===','&&level===0){result.push(text.slice(start,i));start=i+1;}}if(level)throw new Error('Unbalanced Motan dataset');result.push(text.slice(start));return result;
}
export function splitMotanName(name:string):string[]{const at=name.indexOf('(');if(at<1||!name.endsWith(')'))throw new Error('Malformed Motan dataset name');return [name.slice(0,at),...splitMotanParameters(name.slice(at+1,-1))];}
function frozenStatus(value:unknown):Record<string,unknown>{const copy=cloneMotanJson(motanObject(value));if(encodeMotanJson(copy).length>4*1024**2)throw new Error('Motan index status size limit');const freeze=(v:unknown,depth:number)=>{if(depth>64)throw new Error('Motan index nesting limit');if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child,depth+1);Object.freeze(v);}};for(const v of Object.values(copy))motanObject(v);freeze(copy,0);return copy;}
function clock(status:Record<string,unknown>,includePrint=false):number{const th=motanObject(status.toolhead),value=th.estimated_print_time,print=th.print_time??0;if(typeof value!=='number'||!Number.isFinite(value)||includePrint&&(typeof print!=='number'||!Number.isFinite(print)))throw new Error('Invalid Motan index time');return includePrint?Math.max(value,print as number):value;}
interface Dataset {info:DatasetLabel;sample:(time:number)=>Promise<unknown>;}
/** One immutable index window per owner. Reopen to seek or change datasets after sampling. */
export class MotanLogManager {
 readonly initialStatus:Readonly<Record<string,unknown>>;readonly startStatus:Readonly<Record<string,unknown>>;readonly initialStartTime:number;readonly startTime:number;readonly filePosition:number;
 get preserveNumberTypes():boolean{return this.#preserveNumberTypes;}
 readonly #preserveNumberTypes:boolean;readonly #reader:MotanLogReader;readonly #dispatch:MotanDispatcher;readonly #subscriptions:Record<string,unknown>;readonly #datasets=new Map<string,Dataset>();#tracker:MotanStatusTracker|undefined;#started=false;#busy=false;#closed=false;#last=-Infinity;#failure:Error|undefined;#closing:Promise<void>|undefined;
 private constructor(reader:MotanLogReader,initial:Record<string,unknown>,start:Record<string,unknown>,subscriptions:Record<string,unknown>,startTime:number,filePosition:number,dispatch?:DispatchOptions,preserveNumberTypes=false){this.#preserveNumberTypes=preserveNumberTypes;this.#reader=reader;this.#dispatch=new MotanDispatcher(reader,dispatch);this.initialStatus=initial;this.startStatus=start;this.initialStartTime=clock(initial);this.startTime=startTime;this.filePosition=filePosition;this.#subscriptions=subscriptions;}
 static async open(prefix:string,options:MotanManagerOptions={}):Promise<MotanLogManager>{
  const relative=options.start??0,max=options.maxIndexEntries??100000,readerOptions={...options.reader};if(!Number.isFinite(relative)||!Number.isSafeInteger(max)||max<1||max>1000000)throw new Error('Invalid Motan index window');let index:MotanLogReader|undefined,reader:MotanLogReader|undefined;
  try{index=await MotanLogReader.open(prefix+'.index.gz',readerOptions);reader=await MotanLogReader.open(prefix+'.json.gz',readerOptions);const first=await index.pullMessage();if(!first)throw new Error('Empty Motan index');const initial=frozenStatus(first.status),subscriptions=motanObject(first.subscriptions??{});if(Object.keys(subscriptions).length>4096)throw new Error('Motan subscription limit');const startTime=clock(initial)+relative;if(!Number.isFinite(startTime))throw new Error('Motan requested time exceeds finite range');const seekTime=Math.max(clock(initial),startTime-1);let start=initial,position=0,count=1,previousPosition=0;
   for(;;){const entry=await index.pullMessage();if(entry===null)break;if(++count>max)throw new Error('Motan index entry limit');const status=motanObject(entry.status);if(clock(status,true)>seekTime)break;const offset=entry.file_position;if(typeof offset!=='number'||!Number.isSafeInteger(offset)||offset<previousPosition||offset>reader.status.fileSize)throw new Error('Invalid Motan index file position');previousPosition=position=offset;const next=copyMotanStatusRoot(start,status);for(const [key,value] of Object.entries(status)){const old=Object.hasOwn(start,key)?motanObject(start[key]):{};Object.defineProperty(next,key,{value:mergeMotanObjects(old,motanObject(value)),enumerable:true,writable:true,configurable:true});}if(encodeMotanJson(next).length>4*1024**2)throw new Error('Motan index status size limit');start=next;
   }
   if(position)await reader.seek(position);await index.close();index=undefined;const result=new MotanLogManager(reader,initial,start===initial?initial:frozenStatus(start),subscriptions,startTime,position,options.dispatch,readerOptions.preserveNumberTypes);reader=undefined;return result;
  }finally{await Promise.all([index?.close(),reader?.close()]);}
 }
 #check(){if(this.#closed)throw new Error('Motan manager is closed');if(this.#failure)throw this.#failure;}
 #status(){if(!this.#tracker){this.#dispatch.addHandler('status','status');this.#tracker=new MotanStatusTracker(this.startStatus,time=>this.#dispatch.pull(time,'status'));}return this.#tracker;}
 #settings(){return motanObject(motanObject(this.initialStatus.configfile).settings);}
 get status(){return {...this.#dispatch.status,started:this.#started,failed:!!this.#failure||this.#dispatch.status.failed};}
 addDataset(name:string):DatasetLabel{
  this.#check();const existing=this.#datasets.get(name);if(existing)return existing.info;if(this.#started)throw new Error('Register Motan datasets before sampling');if(this.#datasets.size>=127||name.length>1024)throw new Error('Motan dataset limit');const [kind,sensor,selection,...extra]=splitMotanName(name),arity=selection===undefined?1:2;if(extra.length||!motanDatasetTypes.includes(kind)||(['trapq','accelerometer','adxl345','stallguard'].includes(kind)&&arity!==2)||(['angle','status'].includes(kind)&&arity!==1))throw new Error('Invalid Motan dataset type or parameters');
  let subscription=kind==='status'?'':kind==='step_phase'?'stepq:'+motanPhaseConfig(this.#settings(),sensor,selection===undefined?'phase':selection as 'microstep').stepperName:kind+':'+sensor;
  if(subscription&&!Object.hasOwn(this.#subscriptions,subscription)){const suggestions=Object.keys(this.#subscriptions).filter(key=>key.startsWith(subscription.split(':')[0]+':')).slice(0,20);throw new Error(`Dataset ${subscription} not in capture; available: ${suggestions.join(', ')}`);}
  const pull=(time:number)=>this.#dispatch.pull(time,name);let sample:(time:number)=>Promise<unknown>,label='',units='';
  if(kind==='status'){const tracker=this.#status(),handler=new MotanStatusFieldSampler(sensor,time=>tracker.sample(time),this.#preserveNumberTypes);sample=time=>handler.sample(time);label=sensor+' field';units='Unknown';}
  else if(kind==='step_phase'){if(selection!==undefined&&selection!=='microstep')throw new Error('Invalid Motan phase selection');const config=motanPhaseConfig(this.#settings(),sensor,selection===undefined?'phase':'microstep'),tracker=this.#status(),handler=this.#preserveNumberTypes?new MotanTypedPhaseSampler(motanTypedPhaseConfig(this.#settings(),sensor,selection===undefined?'phase':'microstep'),async time=>(await pull(time)) as unknown as StepBlock|null,time=>tracker.sample(time)):new MotanPhaseSampler(config,async time=>(await pull(time)) as unknown as StepBlock|null,time=>tracker.sample(time));sample=time=>handler.sample(time);label=config.stepperName+(selection?' microstep':' phase');units=selection?'Microstep':'Phase';}
  else if(kind==='stepq'){const handler=new MotanStepSampler(async time=>(await pull(time)) as unknown as StepBlock|null,selection===undefined?.01:parsePythonFloat(selection));sample=time=>handler.sample(time);label=sensor+' position';units='Position\n(mm)';}
  else if(kind==='trapq'){const handler=new MotanTrapSampler(selection as TrapSelection,async time=>{const value=await pull(time);return value===null?null:value.data as TrapMove[];});sample=time=>handler.sample(time);const axis='xyz'.includes(selection)&&selection.length===1;label=sensor+' '+(axis?selection+' position':selection.replace('_',' ').replace('accel','acceleration'));units=axis?'Position\n(mm)':selection.endsWith('accel')?'Acceleration\n(mm/s^2)':'Velocity\n(mm/s)';}
  else if(kind==='stallguard'){const handler=new MotanStallguardSampler(selection as 'sg_result'|'cs_actual',async time=>(await pull(time)) as unknown as {data:MotanStallguardRow[]}|null,this.#preserveNumberTypes);sample=time=>handler.sample(time);const driver=Object.keys(this.#settings()).find(key=>key.startsWith('tmc')&&key.endsWith(sensor))??'';label=`${driver} ${sensor} ${selection}`;units=selection==='sg_result'?'Stallguard':'CS Actual';}
  else{let mode:SensorSelection;if(kind==='angle'){mode='angle';label=sensor+' position';units='Position\n(mm)';}else if(kind==='accelerometer'||kind==='adxl345'){if(!['x','y','z'].includes(selection))throw new Error('Invalid accelerometer axis');mode=selection as SensorSelection;label=`${sensor} ${selection} acceleration`;units='Acceleration\n(mm/s^2)';}else if(kind==='ldc1612'){if(selection!==undefined&&!['period','z'].includes(selection))throw new Error('Invalid eddy-current selection');mode=selection==='z'?'height':(selection as 'period'|undefined)??'frequency';label=sensor+' '+mode;units=mode==='height'?'Position\n(mm)':mode==='period'?'Period\n(s)':'Frequency\n(Hz)';}else{if(selection!==undefined&&selection!=='counts')throw new Error('Invalid loadcell selection');mode=selection??'force';label=sensor+' '+mode;units=mode==='counts'?'ADC Counts':'Force\n(g)';}const handler=new MotanSensorSampler(mode,async time=>(await pull(time)) as unknown as SensorBlock|null,mode==='angle'?motanAngleScale(this.#settings(),sensor):1);sample=time=>handler.sample(time);}
  if(subscription)this.#dispatch.addHandler(name,subscription);const info=Object.freeze({name,label,units});this.#datasets.set(name,{info,sample});return info;
 }
 async sample(time:number):Promise<Readonly<Record<string,unknown>>>{this.#check();if(!Number.isFinite(time)||time<this.#last||this.#busy||!this.#datasets.size)throw new Error('Invalid or concurrent Motan manager sample');this.#started=true;this.#last=time;this.#busy=true;try{const values:Record<string,unknown>=Object.create(null);for(const [name,dataset] of this.#datasets){this.#check();values[name]=await dataset.sample(time);}this.#check();return Object.freeze(values);}catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}}
 /** Numeric analysis batch. Preserve time-major subscription consumption while
  * avoiding one result object, freeze and outer promise per sample. */
 async sampleNumeric(times:readonly number[]|Float64Array,maxNumericBytes=64*1024**2,names?:readonly string[]):Promise<Readonly<Record<string,Float64Array>>>{
  this.#check();
  if(this.#busy||!this.#datasets.size)throw new Error('Invalid or concurrent Motan manager sample');
  if(names!==undefined&&(!Array.isArray(names)||names.length>127))throw new Error('Invalid Motan numeric batch datasets');
  const selected=new Set(names??this.#datasets.keys());
  if([...selected].some(name=>!this.#datasets.has(name)))throw new Error('Unknown Motan numeric batch dataset');
  if((!Array.isArray(times)&&!(times instanceof Float64Array))||times.length>2000000
    ||!Number.isSafeInteger(maxNumericBytes)||maxNumericBytes<1||maxNumericBytes>512*1024**2
    ||times.length*(selected.size+1)*8>maxNumericBytes)throw new Error('Motan numeric batch memory or sample limit');
  // Validate exactly the values copied, including caller-owned shared buffers.
  const timeline=new Float64Array(times.length);let previous=this.#last;
  for(let i=0;i<timeline.length;i++){const time=times[i];if(typeof time!=='number'||!Number.isFinite(time)||time<previous)throw new Error('Motan numeric batch requires sequential nondecreasing times');timeline[i]=previous=time;}
  const result:Record<string,Float64Array>=Object.create(null);
  const datasets=Array.from(this.#datasets,([name,dataset])=>({name,dataset,
   values:selected.has(name)?result[name]=new Float64Array(timeline.length):undefined}));
  if(!timeline.length)return Object.freeze(result);
  this.#busy=true;this.#started=true;
  try{
   for(let i=0;i<timeline.length;i++){
    this.#last=timeline[i];
    for(const entry of datasets){
     this.#check();const value=await entry.dataset.sample(timeline[i]);this.#check();
     if(!entry.values)continue;
     if(typeof value!=='number'||!Number.isFinite(value))throw new Error(`Motan numeric analysis cannot represent ${entry.name} at sample ${i}`);
     entry.values[i]=value;
    }
    if((i+1)%256===0&&i+1<timeline.length){await yieldImmediate();this.#check();}
   }
   return Object.freeze(result);
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
 /** Time-major scalar batch without per-row objects. The budget includes a
  * snapshot timeline plus scalar payload charges. Returned columns are owned
  * by the caller; scalarBytes excludes the temporary timeline. */
 async sampleScalars(times:readonly number[]|Float64Array,maxScalarBytes=64*1024**2,names?:readonly string[]):Promise<{datasets:Readonly<Record<string,MotanScalar[]>>;scalarBytes:number}>{
  this.#check();
  if(this.#busy||!this.#datasets.size)throw new Error('Invalid or concurrent Motan manager sample');
  if(names!==undefined&&(!Array.isArray(names)||names.length>127))throw new Error('Invalid Motan scalar batch datasets');
  const selected=new Set(names??this.#datasets.keys());
  if([...selected].some(name=>!this.#datasets.has(name)))throw new Error('Unknown Motan scalar batch dataset');
  if((!Array.isArray(times)&&!(times instanceof Float64Array))||times.length>2000000
    ||!Number.isSafeInteger(maxScalarBytes)||maxScalarBytes<1||maxScalarBytes>512*1024**2
    ||times.length*(selected.size+1)*8>maxScalarBytes)throw new Error('Motan scalar batch memory or sample limit');
  const timeline=new Float64Array(times.length);let previous=this.#last;
  for(let i=0;i<timeline.length;i++){const time=times[i];if(typeof time!=='number'||!Number.isFinite(time)||time<previous)throw new Error('Motan scalar batch requires sequential nondecreasing times');timeline[i]=previous=time;}
  const result:Record<string,MotanScalar[]>=Object.create(null),datasets=Array.from(this.#datasets,([name,dataset])=>({dataset,values:selected.has(name)?result[name]=new Array<MotanScalar>(timeline.length):undefined}));
  let bytes=timeline.length*(selected.size+1)*8;const structured=new WeakMap<object,MotanStructuredCell>();
  if(!timeline.length)return Object.freeze({datasets:Object.freeze(result),scalarBytes:0});
  this.#busy=true;this.#started=true;
  try{
   for(let i=0;i<timeline.length;i++){
    this.#last=timeline[i];
    for(const entry of datasets){
     this.#check();let value=await entry.dataset.sample(timeline[i]);this.#check();
     if(!entry.values)continue;
     if(value!==null&&typeof value==='object'&&this.#preserveNumberTypes){
      const source=value;let cell=structured.get(source);
      if(!Object.isFrozen(source))throw new Error('Motan structured cells require immutable snapshots');
      if(!cell){const remaining=maxScalarBytes-bytes+8-32;if(remaining<1)throw new Error('Motan table memory limit');cell=motanStructuredCell(motanPythonRepr(source,Math.min(1024**2,remaining)));structured.set(source,cell);}value=cell;
     }
     bytes+=motanScalarBytes(value)-8;if(bytes>maxScalarBytes)throw new Error('Motan table memory limit');
     entry.values[i]=value as MotanScalar;
    }
    if((i+1)%256===0){await yieldImmediate();this.#check();}
   }
   return Object.freeze({datasets:Object.freeze(result),scalarBytes:bytes-timeline.byteLength});
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#dispatch.close();this.#datasets.clear();this.#tracker=undefined;this.#closing=this.#reader.close();return this.#closing;}
}
