import {motanTypedValue} from './number-types.ts';
// GPL-3.0-or-later. From readlog.py, copyright (C) 2021 Kevin O'Connor.
import {motanObject,type StatusSnapshot} from './dispatch.ts';
const diagnosticNumber=(value:unknown,typed:boolean)=>typeof value==='number'&&Number.isFinite(value)||typed&&(typeof value==='bigint'||typeof value==='boolean');
const own=(object:Record<string,unknown>,key:string)=>Object.hasOwn(object,key)?object[key]:undefined;
export type MotanStallguardRow=readonly [number,number|bigint|boolean,number|bigint|boolean];
/** Keep the original next-sample selection, including its EOF behavior. */
export class MotanStallguardSampler {
 readonly #source:(time:number)=>Promise<{data:readonly MotanStallguardRow[]}|null>;readonly #column:1|2;readonly #typed:boolean;
 #rows:readonly MotanStallguardRow[]=[];#at=0;#current:MotanStallguardRow|undefined;#last=-Infinity;#busy=false;#failure:Error|undefined;
 constructor(selection:'sg_result'|'cs_actual',source:(time:number)=>Promise<{data:readonly MotanStallguardRow[]}|null>,preserveNumberTypes=false){if(typeof preserveNumberTypes!=='boolean')throw new Error('Invalid Motan Stallguard type mode');this.#typed=preserveNumberTypes;if(selection!=='sg_result'&&selection!=='cs_actual')throw new Error('Invalid Motan Stallguard selection');this.#column=selection==='sg_result'?1:2;this.#source=source;}
 async sample(time:number):Promise<number|bigint|boolean|null>{
  if(this.#failure)throw this.#failure;if(!Number.isFinite(time)||time<this.#last||this.#busy)throw new Error('Motan diagnostic samples require sequential nondecreasing times');this.#last=time;this.#busy=true;
  try{let reads=0;for(;;){if(this.#at===this.#rows.length){if(++reads>4096)throw new Error('Motan diagnostic block limit exceeded');const block=await this.#source(time);if(block===null)return null;if(!block||!Array.isArray(block.data)||block.data.length>65536)throw new Error('Invalid Motan Stallguard block');for(const row of block.data)if(!Array.isArray(row)||row.length!==3||typeof row[0]!=='number'||!Number.isFinite(row[0])||!diagnosticNumber(row[1],this.#typed)||!diagnosticNumber(row[2],this.#typed))throw new Error('Invalid Motan Stallguard row');this.#rows=block.data;this.#at=0;}
    if(!this.#current&&this.#at<this.#rows.length)this.#current=this.#rows[this.#at++];if(this.#current){if(time<=this.#current[0])return this.#typed?motanTypedValue(this.#current as unknown as Record<string,unknown>,String(this.#column)) as number|bigint|boolean:this.#current[this.#column];this.#current=undefined;}
   }
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
export class MotanStatusFieldSampler {
 readonly #preserveNumberTypes:boolean;readonly #parts:string[];readonly #source:(time:number)=>Promise<StatusSnapshot>;#nextTime=0;#value:unknown=null;#last=-Infinity;#busy=false;#failure:Error|undefined;
 constructor(path:string,source:(time:number)=>Promise<StatusSnapshot>,preserveNumberTypes=false){this.#preserveNumberTypes=preserveNumberTypes;if(typeof path!=='string'||path.length>1024||path.split('.').length>64)throw new Error('Invalid Motan status field');this.#parts=path.split('.');this.#source=source;}
 async sample(time:number):Promise<unknown>{
  if(this.#failure)throw this.#failure;if(!Number.isFinite(time)||time<this.#last||this.#busy)throw new Error('Motan diagnostic samples require sequential nondecreasing times');this.#last=time;this.#busy=true;
  try{if(time<this.#nextTime)return this.#value;const snapshot=await this.#source(time);if(!Number.isFinite(snapshot.nextTime))throw new Error('Invalid Motan status snapshot time');let value:unknown=snapshot.status;for(const part of this.#parts.slice(0,-1)){const selected=own(motanObject(value),part);value=selected===undefined?{}:selected;}const object=motanObject(value),key=this.#parts.at(-1)!;this.#value=Object.hasOwn(object,key)?(this.#preserveNumberTypes?motanTypedValue(object,key):object[key]):0;this.#nextTime=snapshot.nextTime;return this.#value;
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
