// Moonraker proc_stats wire semantics; upstream Copyright (C) 2021 Eric Callahan.
// SPDX-License-Identifier: GPL-3.0-or-later
import {open,readdir,access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {uptime} from 'node:os';
import {performance} from 'node:perf_hooks';
import {fixedDecimal} from '../math/python-decimal.ts';
import type {Json} from './rpc.ts';
export interface ProcFiles {rss:string|null;memory:string|null;cpu:string|null;network:string|null;temperature:string|null;}
export type ThrottledState={bits:number;flags:string[];};
export interface ProcStatsSource {read(signal:AbortSignal):Promise<ProcFiles>;throttled?(signal:AbortSignal):Promise<ThrottledState|null>;}
const flags:Record<number,string>={1:'Under-Voltage Detected',2:'Frequency Capped',4:'Currently Throttled',8:'Temperature Limit Active',65536:'Previously Under-Volted',131072:'Previously Frequency Capped',262144:'Previously Throttled',524288:'Previously Temperature Limited'};
export function throttledState(value:string):ThrottledState{
 const match=/^throttled=0x([0-9a-f]{1,8})\s*$/i.exec(value);if(!match)throw new Error('Invalid throttled state');const bits=Number.parseInt(match[1],16);return {bits,flags:Object.entries(flags).filter(([bit])=>(bits&Number(bit))!==0).map(([,name])=>name)};
}
async function boundedRead(path:string,signal:AbortSignal):Promise<string|null>{
 let file:Awaited<ReturnType<typeof open>>|undefined;
 try{signal.throwIfAborted();file=await open(path,'r');const chunks:Buffer[]=[];let used=0;
  while(used<=1024*1024){signal.throwIfAborted();const buffer=Buffer.allocUnsafe(Math.min(32768,1024*1024+1-used)),{bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;used+=bytesRead;chunks.push(buffer.subarray(0,bytesRead));}
  signal.throwIfAborted();return used>1024*1024?null:Buffer.concat(chunks,used).toString('utf8');
 }catch(error){signal.throwIfAborted();return null;}finally{await file?.close();}
}
export function linuxProcSource():ProcStatsSource{
 let temperature:Promise<string>|undefined,hasThrottle:Promise<boolean>|undefined;
 const thermal=async(signal:AbortSignal)=>{try{for(const name of (await readdir('/sys/class/hwmon')).slice(0,256)){
  if(!/^hwmon\d+$/.test(name))continue;const root='/sys/class/hwmon/'+name,value=await boundedRead(root+'/name',signal);
  if(['coretemp','k10temp','cpu_thermal'].includes(value?.trim()??''))return root+'/temp1_input';
 }}catch{signal.throwIfAborted();}return '/sys/class/thermal/thermal_zone0/temp';};
 return {async read(signal){temperature??=thermal(signal);const settled=await Promise.allSettled(['/proc/self/smaps_rollup','/proc/meminfo','/proc/stat','/proc/net/dev',await temperature].map(path=>boundedRead(path,signal)));signal.throwIfAborted();const values=settled.map(result=>{if(result.status==='rejected')throw result.reason;return result.value;});return {rss:values[0],memory:values[1],cpu:values[2],network:values[3],temperature:values[4]};},async throttled(signal){
  hasThrottle??=Promise.all([access('/usr/bin/vcgencmd'),access('/dev/vcio')]).then(()=>true,()=>false);if(!await hasThrottle)return null;signal.throwIfAborted();
  try{const result=await new Promise<string>((resolve,reject)=>{execFile('/usr/bin/vcgencmd',['get_throttled'],{signal,timeout:1000,maxBuffer:1024,encoding:'utf8'},(error,stdout)=>error?reject(error):resolve(stdout));});return throttledState(result);}
  catch{signal.throwIfAborted();return {bits:0,flags:['?']};}
 }};
}
const number=(value:string|undefined)=>{if(value===undefined||!/^\d+$/.test(value))return undefined;const result=Number(value);return Number.isSafeInteger(result)?result:undefined;};
const round=(value:number)=>Number(fixedDecimal(value,2));
type Cpu=Record<string,{total:bigint;idle:bigint}>;
type Network=Record<string,Record<string,number>>;
export function parseProcFiles(files:ProcFiles):{rss:number|null;units:string|null;temperature:number|null;memory:Record<string,number>;cpu:Cpu;network:Network}{
 const rss=/^Rss:\s+(\d+)\s+(\w+)/m.exec(files.rss??''),total=number(/^MemTotal:\s+(\d+)/m.exec(files.memory??'')?.[1]),available=number(/^MemAvailable:\s+(\d+)/m.exec(files.memory??'')?.[1]);
 const cpu:Cpu=Object.create(null),network:Network=Object.create(null);
 for(const line of (files.cpu??'').split('\n').slice(0,4097)){const parts=line.trim().split(/\s+/);if(!/^cpu\d*$/.test(parts[0])||parts.length<5||!parts.slice(1).every(value=>/^\d{1,24}$/.test(value)))continue;const ticks=parts.slice(1).map(BigInt);cpu[parts[0]]={total:ticks.reduce((a,b)=>a+b,0n),idle:ticks[3]};}
 for(const line of (files.network??'').split('\n').slice(0,2050)){const match=/^\s*([\w.-]+):\s*(.+)$/.exec(line);if(!match)continue;const parts=match[2].trim().split(/\s+/),indices=[0,8,1,9,2,10,3,11],values=indices.map(i=>number(parts[i]));if(values.some(v=>v===undefined))continue;
  network[match[1]]=Object.fromEntries(['rx_bytes','tx_bytes','rx_packets','tx_packets','rx_errs','tx_errs','rx_drop','tx_drop'].map((key,i)=>[key,values[i]!]));}
 const temp=(files.temperature??'').trim(),parsedTemp=/^-?\d+$/.test(temp)?Number(temp)/1000:NaN;
 return {rss:number(rss?.[1])??null,units:rss&&number(rss[1])!==undefined?rss[2]:null,temperature:Number.isFinite(parsedTemp)?parsedTemp:null,memory:total!==undefined&&available!==undefined&&available<=total?{total,available,used:total-available}:{},cpu,network};
}
type Sample={time:number;cpu_usage:number;memory:number|null;mem_units:string|null;};
export class ProcStats {
 readonly #source:ProcStatsSource;readonly #clock:()=>number;readonly #wall:()=>number;readonly #cpuTime:()=>number;readonly #uptime:()=>number;readonly #connections:()=>number;readonly #notify:(method:string,value:Json)=>void;
 #timer:ReturnType<typeof setTimeout>|undefined;#pending:Promise<void>|undefined;readonly #abort=new AbortController();
 #history:Sample[]=[];#network:Network={};#cpu:Cpu={};#usage:Record<string,number>={};#memory:Record<string,number>={};#temperature:number|null=null;#throttled:ThrottledState|null=null;
 #last:number;#lastCpu:number;#samples=0;#failures=0;#delayedSamples=0;#running=false;
 constructor(options:{source?:ProcStatsSource;clock?:()=>number;wall?:()=>number;cpuTime?:()=>number;uptime?:()=>number;connections:()=>number;notify:(method:string,value:Json)=>void}){
  this.#source=options.source??linuxProcSource();if(typeof this.#source.read!=='function'||this.#source.throttled!==undefined&&typeof this.#source.throttled!=='function')throw new TypeError('Invalid process statistics source');
  this.#clock=options.clock??(()=>performance.now()/1000);this.#wall=options.wall??(()=>Date.now()/1000);this.#cpuTime=options.cpuTime??(()=>{const cpu=process.cpuUsage();return (cpu.user+cpu.system)/1e6;});this.#uptime=options.uptime??uptime;this.#connections=options.connections;this.#notify=options.notify;this.#last=this.#clock();this.#lastCpu=this.#cpuTime();
 }
 get status(){return {samples:this.#samples,failures:this.#failures,delayedSamples:this.#delayedSamples,pending:!!this.#pending,running:this.#running,closed:this.#abort.signal.aborted};}
 snapshot():Json{return structuredClone({moonraker_stats:this.#history,throttled_state:this.#throttled,cpu_temp:this.#temperature,network:this.#network,system_cpu_usage:this.#usage,system_uptime:this.#uptime(),system_memory:this.#memory,websocket_connections:this.#connections()}) as Json;}
 sample():Promise<void>{
  if(this.#abort.signal.aborted)return Promise.reject(this.#abort.signal.reason);if(this.#pending)return this.#pending;
  const pending=this.#sample().finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async #sample():Promise<void>{
  const now=this.#clock(),cpuTime=this.#cpuTime(),elapsed=now-this.#last;
  if(!Number.isFinite(elapsed)||elapsed<=0||!Number.isFinite(cpuTime)||cpuTime<this.#lastCpu)throw new Error('Invalid process statistics clock');
  const data=parseProcFiles(await this.#source.read(this.#abort.signal));this.#abort.signal.throwIfAborted();
  const usage:Record<string,number>={};for(const [name,current] of Object.entries(data.cpu)){const prior=this.#cpu[name];if(!prior)continue;const total=current.total-prior.total,idle=current.idle-prior.idle;if(total>0n&&idle>=0n&&idle<=total)usage[name]=round(100*Number(total-idle)/Number(total));}
  for(const [name,current] of Object.entries(data.network)){const previous=this.#network[name];const delta=previous?(BigInt(current.rx_bytes)+BigInt(current.tx_bytes)-BigInt(previous.rx_bytes)-BigInt(previous.tx_bytes)):0n;current.bandwidth=delta>=0n?round(Number(delta)/elapsed):0;}
  const result:Sample={time:this.#wall(),cpu_usage:round((cpuTime-this.#lastCpu)/elapsed*100),memory:data.rss,mem_units:data.units};
  if(!Number.isFinite(result.time)||!Number.isFinite(result.cpu_usage))throw new Error('Invalid process statistics values');
  if(elapsed>4)this.#delayedSamples++;this.#cpu=data.cpu;this.#usage=usage;this.#network=data.network;this.#memory=data.memory;this.#temperature=data.temperature;this.#history.push(result);if(this.#history.length>30)this.#history.shift();this.#last=now;this.#lastCpu=cpuTime;this.#samples++;
  this.#notify('notify_proc_stat_update',structuredClone({moonraker_stats:result,cpu_temp:data.temperature,network:this.#network,system_cpu_usage:usage,system_memory:data.memory,websocket_connections:this.#connections()}) as Json);
  if((this.#samples-1)%10===0&&this.#source.throttled){const state=await this.#source.throttled(this.#abort.signal);this.#abort.signal.throwIfAborted();const changed=state&&state.bits!==(this.#throttled?.bits??0);this.#throttled=state;if(changed)this.#notify('notify_cpu_throttled',state as unknown as Json);}
 }
 start():void{if(this.#abort.signal.aborted)throw new Error('Process statistics closed');if(this.#running)return;this.#running=true;this.#schedule();}
 #schedule(){if(this.#abort.signal.aborted)return;this.#timer=setTimeout(()=>{this.#timer=undefined;void this.sample().catch(()=>{if(!this.#abort.signal.aborted)this.#failures++;}).finally(()=>this.#schedule());},1000);this.#timer.unref();}
 async close():Promise<void>{this.#running=false;this.#abort.abort(new Error('Process statistics closed'));clearTimeout(this.#timer);this.#timer=undefined;await this.#pending?.catch(()=>{});}
}
