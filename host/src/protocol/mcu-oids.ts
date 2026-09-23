// Host-side MCU OID ownership. GPL-3.0-or-later.
import type {PrinterPins} from './pins.ts';
export interface MCUOidRequest {mcu:string;owner:string;oid?:number}
interface MCUOwners {owners:Map<string,number>;ids:Set<number>}
/** One registry per hardware assembly, shared by every device builder. An OID
 * is immutable for that assembly; recovery must not recycle firmware objects. */
export class MCUOidRegistry {
 #mcus=new Map<string,MCUOwners>();#building=false;#finalized=new Set<string>();
 /** Synchronous builders must finish all validation before publishing their
  * own resources. A thrown build consumes no OIDs. No async or nested builds. */
 claim<T>(requests:readonly MCUOidRequest[],build:(oids:readonly number[])=>T extends PromiseLike<unknown>?never:T):T {
  if(this.#building)throw new Error('Nested MCU OID allocation');
  if(!requests.length||requests.length>4096)throw new Error('Invalid MCU OID batch');
  const next=new Map([...this.#mcus].map(([mcu,state])=>[mcu,{owners:new Map(state.owners),ids:new Set(state.ids)}]));
  const specs=requests.map(r=>({...r}));
  // Reserve explicit IDs first: an automatic request cannot steal a later
  // explicit request's ID just because it appeared earlier in the batch.
  for(const r of specs){
   if(typeof r.mcu!=='string'||!r.mcu.trim()||r.mcu.length>128||typeof r.owner!=='string'||!r.owner.trim()||r.owner.length>256)throw new Error('Invalid MCU OID owner');
   if(this.#finalized.has(r.mcu))throw new Error('MCU OID configuration is finalized');
   let state=next.get(r.mcu);if(!state){state={owners:new Map(),ids:new Set()};next.set(r.mcu,state);}
   if(state.owners.has(r.owner))throw new Error('Duplicate MCU OID owner');state.owners.set(r.owner,-1);
   if(r.oid!==undefined){if(!Number.isInteger(r.oid)||r.oid<0||r.oid>254)throw new RangeError('Invalid MCU OID');if(state.ids.has(r.oid))throw new Error('Duplicate MCU OID');state.ids.add(r.oid);}
  }
  const oids=Object.freeze(specs.map(r=>{const state=next.get(r.mcu)!;let oid=r.oid;if(oid===undefined){oid=0;while(state.ids.has(oid))oid++;if(oid>254)throw new RangeError('MCU OID capacity exhausted');state.ids.add(oid);}state.owners.set(r.owner,oid);return oid;}));
  this.#building=true;
  try{
   const value=build(oids);
   if(value!==null&&(typeof value==='object'||typeof value==='function')&&'then' in value)throw new TypeError('MCU OID builder must be synchronous');
   this.#mcus=next;return value;
  }finally{this.#building=false;}
 }
 snapshot(mcu:string){
  const state=this.#mcus.get(mcu),owners=Object.freeze([...(state?.owners??[])].map(([owner,oid])=>Object.freeze({owner,oid})));
  return Object.freeze({oidCount:state?.ids.size?Math.max(...state.ids)+1:0,owners});
 }
 /** Call after all device plans compile and before handing their combined
  * configuration to configureMCU. No more firmware objects may be added. */
 finalize(mcu:string){
  if(this.#building)throw new Error('Cannot finalize during MCU OID allocation');
  if(typeof mcu!=='string'||!mcu.trim()||mcu.length>128)throw new Error('Invalid MCU OID owner');
  const result=this.snapshot(mcu);this.#finalized.add(mcu);return result;
 }
}
const registries=new WeakMap<object,MCUOidRegistry>();
/** The same PrinterPins owner must be passed to all machine device builders. */
export function mcuOids<T>(pins:PrinterPins<T>):MCUOidRegistry {
 let registry=registries.get(pins);if(!registry){registry=new MCUOidRegistry();registries.set(pins,registry);}return registry;
}
