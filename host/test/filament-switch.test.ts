import test from 'node:test';
import assert from 'node:assert/strict';
import {FilamentSwitch,readFilamentPolicy} from '../src/inputs/filament-switch.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const policy=(options:Record<string,string>={})=>readFilamentPolicy(new ConfigurationReader(new ConfigurationSource('/filament.cfg',{'filament_switch_sensor tool':options},[]),null),'filament_switch_sensor tool');
function fixture(options:Record<string,string>={}){
 let now=0,printing=true,pauses=0,callback:(time:number,present:boolean)=>void=()=>{},failure:unknown;
 const timers=new Map<()=>void,number>();
 const runtime=new FilamentSwitch({status:{present:false,received:false,time:undefined},subscribe(fn){callback=fn;return ()=>{callback=()=>{};};}},policy(options),{now:()=>now,schedule(fn,seconds){timers.set(fn,now+seconds);return ()=>{timers.delete(fn);};}},()=>printing,async()=>{pauses++;printing=false;},error=>{failure=error;});
 return {runtime,timers,get pauses(){return pauses;},get failure(){return failure;},emit(present:boolean){callback(now,present);},printing(value:boolean){printing=value;runtime.stateChanged();},async advance(to:number){now=to;for(const [fn,at] of [...timers])if(at<=now){timers.delete(fn);fn();}await Promise.resolve();await Promise.resolve();await Promise.resolve();}};
}
test('filament configuration rejects executable macros and invalid delay',()=>{
 assert.deepEqual(policy(),{debounce:0,eventDelay:3,pause:true});
 for(const values of [{runout_gcode:'PAUSE'},{insert_gcode:'RESUME'},{debounce_delay:'-1'},{event_delay:'-1'},{pause_delay:'0'}] as Record<string,string>[])assert.throws(()=>policy(values));
});
test('warmup, bounce and duplicate reports produce one pause and never auto resume',async()=>{
 const f=fixture({debounce_delay:'.1'});f.emit(true);await f.advance(1);assert.equal(f.runtime.status.valid,false);await f.advance(2);assert.equal(f.runtime.status.filament_detected,true);
 f.emit(false);assert.equal(f.runtime.canResume,false);await f.advance(2.05);f.emit(true);await f.advance(2.2);assert.equal(f.pauses,0);assert.equal(f.runtime.canResume,true);
 f.emit(false);await f.advance(2.25);f.emit(false);await f.advance(2.31);assert.equal(f.pauses,1);assert.equal(f.runtime.status.filament_detected,false);
 f.emit(true);await f.advance(2.5);assert.equal(f.pauses,1);assert.equal(f.runtime.status.filament_detected,true);f.runtime.close();assert.equal(f.timers.size,0);
});
test('absent filament rechecks resume after event cooldown, close fences pending timers',async()=>{
 const f=fixture();f.emit(false);await f.advance(2);assert.equal(f.pauses,1);f.printing(true);await f.advance(4);assert.equal(f.pauses,1);await f.advance(5);assert.equal(f.pauses,2);
 f.printing(true);assert.equal(f.timers.size,1);f.runtime.close();await f.advance(10);f.emit(false);assert.equal(f.pauses,2);assert.equal(f.timers.size,0);
});
test('disabled pause still reports filament and bounds timers across repeated changes',async()=>{
 const f=fixture({pause_on_runout:'false'});for(let i=0;i<20000;i++){f.emit(!!(i%2));assert(f.timers.size<=1);}await f.advance(2);f.emit(false);await f.advance(3);assert.equal(f.runtime.status.filament_detected,false);assert.equal(f.pauses,0);f.runtime.close();
});
test('pause rejection is reported once and closes input subscription',async()=>{
 let callback:()=>void=()=>{},faults=0,detached=0;
 const runtime=new FilamentSwitch({status:{received:true,time:0,present:false},subscribe(){return ()=>{detached++;};}},policy(),{now:()=>2,schedule(fn){callback=fn;return ()=>{};}},()=>true,async()=>{throw new Error('pause failed');},()=>{faults++;});
 callback();await new Promise(resolve=>setImmediate(resolve));assert.equal(faults,1);assert.equal(detached,1);runtime.stateChanged();assert.equal(runtime.status.closed,true);
});
