import test from 'node:test';
import assert from 'node:assert/strict';
import {FilamentEncoder} from '../src/inputs/filament-encoder.ts';
function fixture(){
 let now=0,position=0,generation={},printing=false,pauses=0,error:unknown,raw=false,unknown=false,callback:(time:number,present:boolean)=>void=()=>{};
 const timers=new Map<()=>void,number>();
 const encoder=new FilamentEncoder({status:{received:false,present:false,time:undefined},subscribe(fn){callback=fn;return ()=>{callback=()=>{};};}},{pause:true,debounce:0,eventDelay:0,detectionLength:7},{now:()=>now,schedule(fn,seconds){timers.set(fn,now+seconds);return ()=>{timers.delete(fn);};}},()=>unknown?undefined:{position,generation},()=>printing,async()=>{pauses++;printing=false;},e=>{error=e;});
 return {encoder,timers,get pauses(){return pauses;},get error(){return error;},position(p:number){position=p;},printing(){printing=true;encoder.stateChanged();},replace(){generation={};},unknown(){unknown=true;},edge(time=now){raw=!raw;callback(time,raw);},async advance(to:number){now=to;for(let rounds=0;rounds<10;rounds++){const due=[...timers].filter(([,at])=>at<=now);if(!due.length)break;for(const [fn] of due){timers.delete(fn);fn();}}await new Promise(resolve=>setImmediate(resolve));}};
}
test('encoder detects travel without edges, latches pause through rebase, and requires insertion before resume',async()=>{
 const f=fixture();await f.advance(2);assert.equal(f.encoder.canResume,true);f.printing();f.position(6.9);await f.advance(2.25);assert.equal(f.pauses,0);f.position(7);await f.advance(2.5);assert.equal(f.pauses,1);assert.equal(f.encoder.canResume,false);
 f.replace();f.position(0);await f.advance(2.75);assert.equal(f.encoder.canResume,false);f.edge();await f.advance(2.76);assert.equal(f.encoder.canResume,true);assert.equal(f.pauses,1);f.encoder.close();assert.equal(f.timers.size,0);
});
test('delayed ACK uses edge position while publication remains after latest poll',async()=>{
 const f=fixture();await f.advance(2);f.printing();f.position(5);await f.advance(2.25);f.edge(2.1);await f.advance(2.26);assert.equal(f.error,undefined);f.position(11);await f.advance(2.5);assert.equal(f.pauses,0);f.position(12);await f.advance(2.75);assert.equal(f.pauses,1);f.encoder.close();
});
test('missing retained history during printing faults and cancels every timer',async()=>{
 const f=fixture();await f.advance(2);f.printing();f.unknown();await f.advance(2.25);assert.match(String(f.error),/history unavailable/);assert.equal(f.encoder.status.closed,true);assert.equal(f.timers.size,0);assert.equal(f.pauses,0);
});
test('encoder configuration validates extruder ownership, positive travel and rejects macros',async()=>{
 const {readFilamentEncoderPolicy}=await import('../src/inputs/filament-encoder.ts'),{ConfigurationReader}=await import('../src/moonraker/config-reader.ts'),{ConfigurationSource}=await import('../src/moonraker/config-source.ts');
 const read=(values:Record<string,string>)=>readFilamentEncoderPolicy(new ConfigurationReader(new ConfigurationSource('/encoder.cfg',{'filament_motion_sensor tool':values},[]),null),'filament_motion_sensor tool');
 assert.equal(read({extruder:'extruder'}).detectionLength,7);
 for(const values of [{extruder:'missing'},{extruder:'extruder',detection_length:'0'},{extruder:'extruder',runout_gcode:'PAUSE'}] as Record<string,string>[])assert.throws(()=>read(values));
});
