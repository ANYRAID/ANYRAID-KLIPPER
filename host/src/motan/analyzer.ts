// GPL-3.0-or-later. From analyzers.py, copyright (C) 2021 Kevin O'Connor.
import {MotanLogManager,motanDatasetTypes,splitMotanName,type DatasetLabel} from './log-manager.ts';
import {motanObject} from './dispatch.ts';
import {parsePythonFloat,parseConfigurationInteger} from '../moonraker/config-reader.ts';
import {motanDerivative,motanIntegral,motanNorm2,motanSmooth,motanCombine} from './derived-math.ts';
import {motanNotch,motanButterworth} from './sos-design.ts';
import {motanSOSFilter} from './sos-filter.ts';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import {motanScalarDerivative,motanScalarCombine,type MotanScalarSeries} from './scalar-math.ts';
import {motanScalarBytes,type MotanScalar,type MotanTable} from './table.ts';
import {fixedDecimal} from '../math/python-decimal.ts';
const strip=(s:string)=>s.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
interface Node {generateTable?:(data:Record<string,MotanScalarSeries>,maxBytes:number)=>MotanScalarSeries;info:DatasetLabel;generate?:(data:Record<string,Float64Array>)=>Float64Array;}
export interface MotanAnalysis {times:Float64Array;datasets:Readonly<Record<string,Float64Array>>;labels:Readonly<Record<string,DatasetLabel>>;}
export class MotanAnalyzer {
 readonly #manager:MotanLogManager;readonly #segment:number;readonly #samples:number;readonly #bytes:number;readonly #nodes=new Map<string,Node>();readonly #pending=new Set<string>();#started=false;#hasSOS=false;#sosExtraPoints=0;#failure:Error|undefined;
 constructor(manager:MotanLogManager,segmentTime:number,options:{maxSamples?:number;maxNumericBytes?:number}={}){this.#manager=manager;this.#segment=segmentTime;this.#samples=options.maxSamples??1000000;this.#bytes=options.maxNumericBytes??64*1024**2;if(!Number.isFinite(segmentTime)||segmentTime<=0||!Number.isSafeInteger(this.#samples)||this.#samples<1||this.#samples>2000000||!Number.isSafeInteger(this.#bytes)||this.#bytes<1||this.#bytes>512*1024**2)throw new Error('Invalid Motan analysis limits');}
 #check(){if(this.#failure)throw this.#failure;if(this.#started)throw new Error('Motan analysis can only run once');}
 addDataset(name:string):DatasetLabel{this.#check();try{return this.#add(strip(name),0).info;}catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}}
 #add(name:string,depth:number):Node{
  const existing=this.#nodes.get(name);if(existing)return existing;if(depth>64||this.#nodes.size>=256||this.#pending.has(name)||name.length>4096)throw new Error('Motan analysis dependency limit');this.#pending.add(name);try{const [kind,...params]=splitMotanName(name);if(motanDatasetTypes.includes(kind)){const node={info:this.#manager.addDataset(name)};this.#nodes.set(name,node);return node;}
   const arity:Record<string,[number,number]>={derivative:[1,1],integral:[1,3],norm2:[2,3],smooth:[1,2],kin:[1,1],corexy:[3,3],deviation:[2,2],sos:[5,6]};if(!arity[kind]||params.length<arity[kind][0]||params.length>arity[kind][1])throw new Error('Invalid Motan analyzer or parameters');const dependency=(value:string)=>{const key=strip(value);return {key,node:this.#add(key,depth+1)};};let label='',units='',generate:Node['generate'],generateTable:Node['generateTable'];
   if(kind==='kin'){const stepper=params[0],kin=motanObject(motanObject(motanObject(this.#manager.initialStatus.configfile).settings).printer).kinematics;if(!['cartesian','corexy'].includes(kin as string)||!['stepper_x','stepper_y','stepper_z'].includes(stepper))throw new Error('Unsupported Motan kinematics or stepper');const axis=stepper.at(-1)!;if(kin==='corexy'&&axis!=='z'){const a=dependency('trapq(toolhead,x)'),b=dependency('trapq(toolhead,y)');generate=data=>motanCombine(data[a.key],data[b.key],axis==='x'?'kin_x':'kin_y');}else{const source=dependency(`trapq(toolhead,${axis})`);generate=data=>new Float64Array(data[source.key]);}label='Position';units='Position\n(mm)';}
   else if(kind==='corexy'){if(!['x','y'].includes(params[0]))throw new Error('Invalid Motan corexy axis');const a=dependency(params[1]),b=dependency(params[2]);generate=data=>motanCombine(data[a.key],data[b.key],params[0]==='x'?'corexy_x':'corexy_y');generateTable=(data,maxBytes)=>motanScalarCombine(data[a.key],data[b.key],params[0]==='x'?'corexy_x':'corexy_y',maxBytes);label=`Derived ${params[0]} position`;units='Position\n(mm)';}
   else if(kind==='norm2'){const deps=params.map(dependency),words=['position','velocity','acceleration'],dataName=words.find(word=>deps[0].node.info.label.includes(word))??'';label=deps.map(({node})=>{let text=node.info.label;for(const word of words)text=strip(text.replaceAll(word,''));return text;}).join('+')+' '+dataName+' norm2';units=deps[0].node.info.units;generate=data=>motanNorm2(deps.map(({key})=>data[key]));}
   else{const source=dependency(params[0]),info=source.node.info;label=info.label;units=info.units;
    if(kind==='sos'){
     const mode=params[1];if(mode!=='filt'&&mode!=='filtfilt')throw new Error('Invalid Motan SOS mode');
     const filter=params[2];let sos,description;
     if(filter==='notch'){
      if(params.length!==5)throw new Error('Invalid Motan notch parameters');
      const frequency=parsePythonFloat(params[3]),quality=parsePythonFloat(params[4]);sos=motanNotch(frequency,quality,1/this.#segment);
      description=`notch ${fixedDecimal(frequency,1)}Hz Q: ${fixedDecimal(quality,1)}`;
     }else if(filter==='lowpass'||filter==='highpass'||filter==='bandpass'){
      if(params.length!==(filter==='bandpass'?6:5))throw new Error('Invalid Motan Butterworth parameters');
      const order=parseConfigurationInteger(params[3]),low=parsePythonFloat(params[4]),high=filter==='bandpass'?parsePythonFloat(params[5]):undefined;
      sos=motanButterworth(order,high===undefined?low:[low,high],filter,1/this.#segment);
      description=`${filter} ${high===undefined?fixedDecimal(low,0):fixedDecimal(low,1)+'..'+fixedDecimal(high,1)}Hz order ${order}`;
     }else throw new Error('Unknown Motan SOS filter');
     const edge=3*(2*sos.length+1-Math.min(sos.filter(row=>row[2]===0).length,sos.filter(row=>row[5]===0).length));
     this.#sosExtraPoints=Math.max(this.#sosExtraPoints,2*edge+2*sos.length);
     this.#hasSOS=true;generate=data=>motanSOSFilter(sos,data[source.key],mode);
     label=`SOS ${description} (${label})`;
    }
    else if(kind==='deviation'){const ref=dependency(params[1]);generate=data=>motanCombine(data[source.key],data[ref.key],'deviation');generateTable=(data,maxBytes)=>motanScalarCombine(data[source.key],data[ref.key],'deviation',maxBytes);if(units!==ref.node.info.units){label='Deviation';units='Unknown';}else{label+=' deviation';const [first,...rest]=units.split('\n');units=[first,'Deviation',...rest].join('\n');}}
    else if(kind==='smooth'){const time=params[1]===undefined?.01:parsePythonFloat(params[1]);if(!Number.isFinite(time)||time<0)throw new Error('Invalid Motan smoothing time');generate=data=>motanSmooth(data[source.key],this.#segment,time);label='Smoothed '+label;}
    else{const integral=kind==='integral';let replacements:[string,string][]|undefined;if(integral){if(units.includes('(mm/s)'))replacements=[['Velocity','Position'],['(mm/s)','(mm)']];else if(units.includes('(mm/s^2)'))replacements=[['Acceleration','Velocity'],['(mm/s^2)','(mm/s)']];const ref=params[1]===undefined?undefined:dependency(params[1]),halfLife=params[2]===undefined?.015:parsePythonFloat(params[2]);if(!Number.isFinite(halfLife)||halfLife<0)throw new Error('Invalid Motan integral half-life');generate=data=>motanIntegral(data[source.key],this.#segment,ref?data[ref.key]:undefined,halfLife);}else{if(units.includes('(mm)'))replacements=[['Position','Velocity'],['(mm)','(mm/s)']];else if(units.includes('(mm/s)'))replacements=[['Velocity','Acceleration'],['(mm/s)','(mm/s^2)']];generate=data=>motanDerivative(data[source.key],this.#segment);generateTable=data=>motanScalarDerivative(data[source.key],this.#segment);}
     if(replacements){for(const [old,next] of replacements){label=label.replaceAll(old,next).replaceAll(old.toLowerCase(),next.toLowerCase());units=units.replaceAll(old,next).replaceAll(old.toLowerCase(),next.toLowerCase());}}else{label=integral?'Integral':'Derivative of '+label;units='Unknown';}
    }
   }
   if(this.#nodes.size>=256)throw new Error('Motan analysis dependency limit');const node={info:Object.freeze({name,label,units}),generate,generateTable};this.#nodes.set(name,node);return node;
  }finally{this.#pending.delete(name);}
 }
 #numericBytes(count:number):number{return count*(this.#nodes.size+3)*8+(this.#hasSOS?(count+this.#sosExtraPoints)*8:0);}
 async generate(duration=5):Promise<MotanAnalysis>{
  this.#check();if(!Number.isFinite(duration)||duration<0||!this.#nodes.size)throw new Error('Invalid Motan analysis duration or datasets');this.#started=true;
  try{const start=this.#manager.startTime,end=start+duration;if(!Number.isFinite(end))throw new Error('Motan analysis time exceeds finite range');let t=start;const absolute:number[]=[];while(t<end){const next=t+this.#segment;if(!(next>t))throw new Error('Motan segment cannot advance the time axis');if(absolute.length>=this.#samples)throw new Error('Motan analysis sample limit');if(this.#numericBytes(absolute.length+1)>this.#bytes)throw new Error('Motan analysis numeric memory limit');t=next;absolute.push(t);}const count=absolute.length;if(this.#numericBytes(count)>this.#bytes)throw new Error('Motan analysis numeric memory limit');const times=Float64Array.from(absolute,time=>time-this.#manager.initialStartTime),data:Record<string,Float64Array>=Object.create(null),labels:Record<string,DatasetLabel>=Object.create(null);for(const [name,node] of this.#nodes)labels[name]=node.info;
   Object.assign(data,await this.#manager.sampleNumeric(absolute,this.#bytes,[...this.#nodes].filter(([,node])=>!node.generate).map(([name])=>name)));
   for(const [name,node] of this.#nodes)if(node.generate)data[name]=node.generate(data);return {times,datasets:Object.freeze(data),labels:Object.freeze(labels)};
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}
 }
 /** Mixed scalar export. Numeric dependencies are checked on first use, so a
  * BigInt column is never silently narrowed just because another column is derived. */
 async generateTable(duration=5):Promise<MotanTable>{
  this.#check();if(!Number.isFinite(duration)||duration<0||!this.#nodes.size)throw new Error('Invalid Motan analysis duration or datasets');this.#started=true;
  try{
   const start=this.#manager.startTime,end=start+duration,absolute:number[]=[];
   if(!Number.isFinite(end))throw new Error('Motan analysis time exceeds finite range');
   const raw=[...this.#nodes].filter(([,node])=>!node.generate);
   // Reserve raw reference slots plus possible numeric dependency copies.
   const reserved=(count:number)=>this.#numericBytes(count)+raw.length*count*8;
   for(let t=start;t<end;){const next=t+this.#segment;if(!(next>t))throw new Error('Motan segment cannot advance the time axis');
    if(absolute.length>=this.#samples)throw new Error('Motan analysis sample limit');
    if(reserved(absolute.length+1)>this.#bytes)throw new Error('Motan table memory limit');absolute.push(t=next);
   }
   const times=Float64Array.from(absolute,time=>time-this.#manager.initialStartTime);
   const data:Record<string,MotanScalarSeries>=Object.create(null),labels:Record<string,DatasetLabel>=Object.create(null);
   for(const [name,node]of this.#nodes){labels[name]=node.info;if(!node.generate)data[name]=new Array<MotanScalar>(times.length);}
   let bytes=reserved(times.length);
   for(let i=0;i<absolute.length;i++){
    const row=await this.#manager.sample(absolute[i]);
    for(const [name]of raw){const value=row[name];bytes+=motanScalarBytes(value)-8;
     if(bytes>this.#bytes)throw new Error('Motan table memory limit');(data[name] as MotanScalar[])[i]=value as MotanScalar;}
    if((i+1)%256===0)await yieldImmediate();
   }
   // Promote only already-Number columns before derived evaluation. This
   // avoids repeated type scans/copies while preserving integer scalar columns.
   for(const [name,values]of Object.entries(data))if(Array.isArray(values)&&values.every(value=>typeof value==='number'))data[name]=Float64Array.from(values as number[]);
   const numeric:Record<string,Float64Array>=Object.create(null);
   const dependencies=new Proxy(numeric,{get:(target,key)=>{
    if(typeof key!=='string')return undefined;if(Object.hasOwn(target,key))return target[key];
    const values=data[key];if(!values)throw new Error('Unknown Motan numeric dependency');
    if(values instanceof Float64Array)return target[key]=values;
    const result=new Float64Array(values.length);
    for(let i=0;i<values.length;i++){const value=values[i];if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Motan derived analysis requires finite Number values: '+key);result[i]=value;}
    return target[key]=result;
   }});
   for(const [name,node]of this.#nodes)if(node.generate){
    const values=node.generateTable?node.generateTable(data,this.#bytes-bytes+times.length*8):node.generate(dependencies);
    if(!(values instanceof Float64Array))for(const value of values){bytes+=motanScalarBytes(value)-8;if(bytes>this.#bytes)throw new Error('Motan table memory limit');}
    data[name]=values;
   }
   for(const [name,values]of Object.entries(data))if(Array.isArray(values)){
    if(values.every(value=>typeof value==='number'))data[name]=numeric[name]??Float64Array.from(values as number[]);
    else Object.freeze(values);
   }
   return {times,datasets:Object.freeze(data),labels:Object.freeze(labels)};
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}
 }

}
