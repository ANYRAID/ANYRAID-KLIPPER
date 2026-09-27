import test from 'node:test';
import assert from 'node:assert/strict';
import {LinearHomingCommand} from '../src/homing/linear-command.ts';
import {safeZHomingSettings,type SafeZHoming} from '../src/homing/safe-z-home.ts';
import {readSafeZHoming} from '../src/config/safe-z-home.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {linearHomingFixture} from './helpers/linear-homing.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
const signal=()=>new AbortController().signal;
const policy:SafeZHoming={position:[50,60],hop:5,hopSpeed:15,speed:50,moveToPrevious:true};
function fixture(settings=policy){const f=linearHomingFixture({retractDistance:0});f.rails[1].endstop=150;Object.defineProperty(f.port,'safeZHoming',{value:settings});
 f.port.homingTravel=async(p,speed,s)=>{s.throwIfAborted();f.kin.check(new Move(motionLimits(300,3000),f.port.position(),p,speed));f.port.move(p,speed);};
 return {...f,owner:new LinearHomingCommand(f.kin,f.coordinates,f.port,f.rails)};}
test('safe home lifts unknown Z without granting it, homes XY, positions Z and returns only XY',async()=>{
 const f=fixture(),original=f.port.retract;f.port.retract=async(...args)=>{assert(!f.kin.status.homedAxes.includes('z'));await original(...args);};
 await f.owner.home([0,1,2],signal());assert.equal(f.kin.status.homedAxes,'xyz');assert.deepEqual(f.port.position(),[.02,150.02,5,7]);assert.deepEqual(f.coordinates.state.position,f.port.position());
 const events=f.events.filter(e=>e.kind!=='drain');assert.deepEqual(events.slice(0,2).map(e=>[e.kind,e.position[2]]),[['force',0],['retract',5]]);
 assert.deepEqual(events.filter(e=>e.kind==='home').map(e=>e.axis),[0,1,2]);assert.deepEqual(events.filter(e=>e.kind==='move').map(e=>e.position),[[50,60,5,7],[50,60,5,7],[.02,150.02,5,7]]);
});
for(const height of [2,40])test(`known Z is raised only below the hop and retained for XY-only homing (${height})`,async()=>{
 const f=fixture();await f.port.forcePosition([25,35,height,7],signal());f.events.length=0;f.kin.markHomed([2]);await f.owner.home([0],signal());
 assert.equal(f.kin.status.homedAxes,'xz');assert.equal(f.port.position()[2],Math.max(height,5));assert(!f.events.some(e=>e.kind==='retract'||e.kind==='force'&&e.position[2]===0));assert.equal(f.events.filter(e=>e.kind==='move').length,height<5?1:0);
});
test('Z-only requires existing XY and optional return is independent of hop',async()=>{
 const bad=fixture();await assert.rejects(bad.owner.home([2],signal()),/homed XY/);assert.equal(bad.kin.status.homedAxes,'');assert(!bad.events.some(e=>e.kind==='home'));
 const f=fixture({...policy,hop:0,moveToPrevious:false});f.kin.markHomed([0,1]);await f.owner.home([2],signal());assert.deepEqual(f.port.position(),[50,60,.02,7]);assert.equal(f.kin.status.homedAxes,'xyz');assert.equal(f.events.filter(e=>e.kind==='move').length,1);
});
test('configuration rejects out-of-range paths, negative hop, bad speeds and override conflicts before motion',()=>{
 const limits={axisMinimum:[0,0,0],axisMaximum:[200,200,200]};
 for(const change of [{position:[-1,0]},{position:[0,201]},{hop:-1},{hop:201},{hopSpeed:0},{speed:Infinity}] as Partial<SafeZHoming>[])assert.throws(()=>safeZHomingSettings({...policy,...change},limits));
 assert.equal(readSafeZHoming(linearMotionReader(),limits),undefined);assert.deepEqual(readSafeZHoming(linearMotionReader({safe_z_home:{home_xy_position:'50,60'}}),limits),{position:[50,60],hop:0,hopSpeed:15,speed:50,moveToPrevious:false});assert.throws(()=>readSafeZHoming(linearMotionReader({safe_z_home:{home_xy_position:'50,60'},homing_override:{}}),limits),/conflicts/);
});
test('cancelling XY positioning stops and revokes homing without a late Z seek',async()=>{
 const f=fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController();f.kin.markHomed([0,1]);f.port.homingTravel=async()=>{entered.resolve();await release.promise;};
 const running=f.owner.home([2],abort.signal),rejected=assert.rejects(running,/cancel safe home/);await entered.promise;abort.abort(new Error('cancel safe home'));await rejected;release.resolve();await new Promise(r=>setImmediate(r));assert.equal(f.kin.status.homedAxes,'');assert(!f.events.some(e=>e.kind==='home'));assert.equal(f.owner.status.busy,false);
});
