/** Experimental native template candidate. Not automatically installed into the
 * configured server until complete template and hardware gates are satisfied. */
import {createRequire} from 'node:module';
import type {SensorRenderer} from './sensor-messages.ts';
export interface NativeReading {name:string;numberType:'integer'|'float'|'boolean';numberValue?:number;booleanValue?:boolean;}
interface Handle {render(payload:string):NativeReading[];close():void;}
export class NativeTemplateCandidate {
 readonly #handle:Handle;
 constructor(source:string){if(typeof source!=='string'||!source.isWellFormed())throw new TypeError('Invalid template source');const addon=createRequire(import.meta.url)('../../build/template.node') as {NativeSensorTemplate:new(source:string)=>Handle};this.#handle=new addon.NativeSensorTemplate(source);}
 render(payload:string):NativeReading[]{if(typeof payload!=='string'||!payload.isWellFormed())throw new TypeError('Invalid template payload');return this.#handle.render(payload);}
 readonly renderer:SensorRenderer=context=>{for(const value of this.render(context.payload))context.setResult(value.name,value.numberType==='boolean'?value.booleanValue!:value.numberValue!,value.numberType==='boolean'?undefined:value.numberType);};
 close():void{this.#handle.close();}
}
