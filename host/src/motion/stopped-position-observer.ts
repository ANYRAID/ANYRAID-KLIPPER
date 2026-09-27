/** Internal driver observers, keyed by physical MCU session and stepper OID.
 * Notify only after trigger-stop confirmation and position readback, while the
 * motion owner retains exclusive control. No observer may enqueue movement. */
type Observer=(position:bigint,signal:AbortSignal)=>Promise<void>;
const observers=new WeakMap<object,Map<number,{observer:Observer}>>();
export function registerStoppedPositionObserver(session:object,oid:number,observer:Observer):()=>void{
 if(!Number.isInteger(oid)||oid<0||oid>254||typeof observer!=='function')throw new RangeError('Invalid stopped-position observer');
 let slots=observers.get(session);if(!slots){slots=new Map();observers.set(session,slots);}if(slots.has(oid))throw new Error('Stopped-position observer already owned');const entry={observer};slots.set(oid,entry);
 return ()=>{if(slots!.get(oid)===entry)slots!.delete(oid);};
}
export async function observeStoppedPosition(session:object,oid:number,position:bigint,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();const observer=observers.get(session)?.get(oid)?.observer;if(observer)await observer(position,signal);signal.throwIfAborted();
}
