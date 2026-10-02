// GPL-3.0-or-later. From readlog.py, copyright (C) 2021 Kevin O'Connor.
import {parsePythonFloat} from '../moonraker/config-reader.ts';
export type SensorSelection='x'|'y'|'z'|'angle'|'frequency'|'period'|'height'|'force'|'counts';
type Scalar=number|bigint;
export interface SensorBlock {data:readonly (readonly Scalar[])[];position_offset?:number|null;}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Invalid Motan sensor settings');return v as Record<string,unknown>;};
const own=(v:Record<string,unknown>,key:string)=>Object.hasOwn(v,key)?v[key]:undefined;
/** Preserve the original sequential gear-ratio multiplication order. */
export function motanAngleScale(settings:Record<string,unknown>,name:string):number{
 const angle=object(own(settings,`angle ${name}`)??{}),stepper=own(angle,'stepper');if(stepper===undefined||stepper===null)return 1;if(typeof stepper!=='string')throw new Error('Invalid angle stepper');const config=object(own(settings,stepper)??{});let distance=own(config,'rotation_distance')??1;let gears=own(config,'gear_ratio')??[];if(!finite(distance)||distance<=0)throw new Error('Invalid angle rotation distance');
 if(typeof gears==='string')gears=gears.split(',').map(pair=>pair.split(':').map(value=>{try{return parsePythonFloat(value);}catch{throw new Error('Invalid angle gear number');}}));
 if(!Array.isArray(gears)||gears.length>64)throw new Error('Invalid angle gear ratios');for(const pair of gears){if(!Array.isArray(pair)||pair.length!==2||!pair.every(v=>finite(v)&&v>0))throw new Error('Invalid angle gear ratio');distance*=pair[1]/pair[0];}const scale=distance/65536;if(!finite(scale)||scale<=0)throw new Error('Invalid angle scale');return scale;
}
/** Integer angle subtraction occurs before conversion, as in Python. */
function difference(next:Scalar,previous:Scalar):number{
 if(typeof next==='bigint'||typeof previous==='bigint')return Number(BigInt(next)-BigInt(previous));return next-previous;
}
export class MotanSensorSampler {
 readonly #source:(time:number)=>Promise<SensorBlock|null>;readonly #selection:SensorSelection;readonly #width:number;readonly #column:number;readonly #scale:number;
 #rows:readonly (readonly Scalar[])[]=[];#at=0;#previousTime=0;#nextTime=0;#previous:Scalar=0;#next:Scalar=0;#offset=0;#last=-Infinity;#lastRow=-Infinity;#busy=false;#failure:Error|undefined;
 constructor(selection:SensorSelection,source:(time:number)=>Promise<SensorBlock|null>,angleScale=1){
  if(!['x','y','z','angle','frequency','period','height','force','counts'].includes(selection)||!finite(angleScale)||angleScale<=0)throw new Error('Invalid Motan sensor selection');this.#source=source;this.#selection=selection;this.#scale=angleScale;this.#width=selection==='angle'?2:['frequency','period','height'].includes(selection)?3:4;this.#column=selection==='y'||selection==='counts'||selection==='height'?2:selection==='z'?3:1;
 }
 #accept(block:SensorBlock):void{
  if(!block||!Array.isArray(block.data)||block.data.length>65536)throw new Error('Invalid Motan sensor block');let last=this.#lastRow;
  for(const row of block.data){if(!Array.isArray(row)||row.length!==this.#width||!finite(row[0])||row[0]<last)throw new Error('Invalid Motan sensor row or timestamp');last=row[0];for(let col=1;col<row.length;col++){const value=row[col];if(this.#selection==='angle'&&col===1){if(typeof value!=='bigint'&&(!finite(value)||!Number.isSafeInteger(value)))throw new Error('Angle count must be an exact integer');if(!finite(Number(value)))throw new Error('Angle count exceeds finite range');}else if(!finite(value))throw new Error('Invalid Motan sensor value');}}
  if(this.#selection==='angle'&&block.position_offset!==undefined&&block.position_offset!==null){if(!finite(block.position_offset))throw new Error('Invalid angle position offset');this.#offset=block.position_offset;}
  this.#lastRow=last;this.#rows=block.data;this.#at=0;
 }
 async sample(time:number):Promise<number>{
  if(this.#failure)throw this.#failure;if(!finite(time)||time<this.#last||this.#busy)throw new Error('Motan sensor samples require sequential nondecreasing times');this.#last=time;this.#busy=true;
  try{let reads=0;for(;;){if(time<=this.#nextTime){const duration=this.#nextTime-this.#previousTime;if(!(duration>0))throw new Error('Motan sensor interpolation interval is not positive');let previous=this.#previous,next=this.#next;
     if(this.#selection==='period'){if(next===0||previous===0)throw new Error('Cannot interpolate reciprocal of zero frequency');next=1/Number(next);previous=1/Number(previous);}
     const delta=difference(next,previous),elapsed=time-this.#previousTime;let result=Number(previous)+elapsed*delta/duration;if(this.#selection==='angle')result=result*this.#scale+this.#offset;if(!finite(result))throw new Error('Motan sensor interpolation exceeds finite range');return result;
    }
    if(this.#at>=this.#rows.length){if(++reads>4096)throw new Error('Motan sensor source block limit exceeded');const block=await this.#source(time);if(block===null){const result=this.#selection==='angle'?Number(this.#next)*this.#scale+this.#offset:0;if(!finite(result))throw new Error('Motan sensor result exceeds finite range');return result;}this.#accept(block);continue;}
    const row=this.#rows[this.#at++];this.#previousTime=this.#nextTime;this.#previous=this.#next;this.#nextTime=row[0] as number;this.#next=row[this.#column];
   }
  }catch(error){this.#failure=error instanceof Error?error:new Error(String(error));throw this.#failure;}finally{this.#busy=false;}
 }
}
