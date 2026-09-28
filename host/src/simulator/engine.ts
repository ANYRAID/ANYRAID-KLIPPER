import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
export interface SimulationStep {time:bigint;bytes:Buffer;}
/** Dedicated process isolates simulavr's process-global registries and CPU work. */
export class AVREngine {
 #child:ChildProcessWithoutNullStreams;#buffer:Buffer=Buffer.alloc(0);#fault:Error|undefined;#closed=false;#stderr='';#time=0n;
 #pending:{resolve:(v:SimulationStep)=>void;reject:(e:Error)=>void;minimum:bigint}[]=[];
 readonly exited:Promise<void>;
 constructor(binary:string,elf:string,{machine='atmega644',speed=16000000,baud=250000,trace}:{machine?:string;speed?:number;baud?:number;trace?:{file:string;signals:string}}={}){
  if(!/^[a-z0-9]+$/i.test(machine)||!Number.isInteger(speed)||speed<1||speed>1e9||!Number.isInteger(baud)||baud<1||baud>1e8)throw new RangeError('Invalid AVR simulation settings');
  if(trace&&(!trace.file||!trace.signals||trace.signals==='?'||/[\0\r\n]/.test(trace.file+trace.signals)))throw new RangeError('Invalid AVR trace settings');
  this.#child=spawn(binary,[machine,String(speed),String(baud),elf,...trace?[trace.file,trace.signals]:[]],{stdio:'pipe'});
  this.#child.stderr.on('data',(data:Buffer)=>{this.#stderr=(this.#stderr+data.toString()).slice(-8192);});
  this.#child.stdout.on('data',(data:Buffer)=>{try{this.#receive(data);}catch(error){this.#fail(error as Error);}});
  this.#child.stdin.on('error',error=>this.#fail(error));
  this.exited=new Promise((resolve,reject)=>{
   this.#child.on('error',error=>{this.#fail(error);reject(error);});
   this.#child.on('close',(code,signal)=>{
    if(code!==0||this.#pending.length||this.#buffer.length||!this.#closed){const error=this.#fault??new Error(`AVR engine stopped (${code??signal}): ${this.#stderr}`);this.#fail(error);reject(error);}
    else resolve();
   });
  });
  // Callers observe failure through advance/close; avoid an unhandled early exit.
  void this.exited.catch(()=>{});
 }
 #fail(error:Error){if(this.#fault)return;this.#fault=error;for(const request of this.#pending.splice(0))request.reject(error);this.#child.kill();}
 #receive(data:Buffer){
  this.#buffer=Buffer.concat([this.#buffer,data]);
  while(this.#buffer.length>=12){
   const length=this.#buffer.readUInt32LE(8);if(length>65536)throw new Error('Invalid AVR output size');
   if(this.#buffer.length<12+length)return;
   const request=this.#pending.shift();if(!request)throw new Error('Unexpected AVR response');
   const time=this.#buffer.readBigUInt64LE();
   if(time<this.#time+request.minimum){const error=new Error('AVR simulation clock regressed');request.reject(error);throw error;}
   this.#time=time;const bytes=Buffer.from(this.#buffer.subarray(12,12+length));this.#buffer=this.#buffer.subarray(12+length);request.resolve({time,bytes});
  }
 }
 advance(nanoseconds:number,bytes:Uint8Array=new Uint8Array()):Promise<SimulationStep>{
  if(this.#fault)return Promise.reject(this.#fault);
  if(this.#closed)return Promise.reject(new Error('AVR engine closed'));
  if(!Number.isInteger(nanoseconds)||nanoseconds<1||nanoseconds>100000000||bytes.length>65536)return Promise.reject(new RangeError('Invalid AVR simulation request'));
  if(this.#pending.length>=16)return Promise.reject(new Error('AVR request capacity exceeded'));
  const header=Buffer.alloc(8);header.writeUInt32LE(bytes.length);header.writeUInt32LE(nanoseconds,4);
  return new Promise((resolve,reject)=>{
   this.#pending.push({resolve,reject,minimum:BigInt(nanoseconds)});
   this.#child.stdin.write(Buffer.concat([header,bytes]),error=>{if(error)this.#fail(error);});
  });
 }
 async close():Promise<void>{if(!this.#closed){this.#closed=true;this.#child.stdin.end();}await this.exited;}
 async abort():Promise<void>{this.#closed=true;this.#fail(new Error('AVR engine aborted'));try{await this.exited;}catch{/* expected termination */}}
}
