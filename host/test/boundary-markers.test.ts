import test from 'node:test';
import assert from 'node:assert/strict';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {markMoveEnd,validateEndMarkers} from '../src/motion/boundary-markers.ts';
import {planPathStop} from '../src/motion/path-stop.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {idleMotionFixture} from './helpers/idle-motion.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
const signal=()=>new AbortController().signal;
function path(){const q=new LookAheadQueue(),limits=motionLimits(100,10,5,0);let previous=[0,0,0,0];for(const [i,x] of [16,100].entries()){const end=[x,0,0,x/10],m=new Move(limits,previous,end,10);markMoveEnd(m,i+1);q.add(m);previous=end;}return q.flush();}
test('brake keeps only crossed endpoint markers and resume retains future markers exactly once',()=>{
 const moves=path(),stop=planPathStop(moves,2);assert.equal(stop.brake.length,2);
 assert.deepEqual(stop.brake.map(m=>m.endMarkers),[[1],undefined]);assert.deepEqual(stop.remainder.map(m=>m.endMarkers),[[2]]);assert.equal(stop.brake[0].endPos[0],16);assert.equal(stop.position[0],20);
 moves[1].endMarkers=[99];assert.deepEqual(stop.remainder[0].endMarkers,[2]);assert(Object.isFrozen(stop.remainder[0].endMarkers));
 const q=new LookAheadQueue();q.addBatch(stop.remainder);assert.deepEqual(q.flush()[0].endMarkers,[2]);
 const complete=path(),duration=complete.reduce((n,m)=>n+m.profile!.accelT+m.profile!.cruiseT+m.profile!.decelT,0),end=planPathStop(complete,duration);assert.deepEqual(end.brake,[]);assert.deepEqual(end.remainder,[]);
});
test('marker is attached only to the final mesh split without adding motion or changing lookahead',()=>{
 const mesh=new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[0,.2],[0,.2]]);
 const make=()=>new BedMeshMovePort({mesh,physicalPosition:[0,0,0,0],limits:motionLimits(300,3000),validate(){}}),marked=make(),plain=make();assert.equal(marked.markPendingBoundary(1),false);assert.throws(()=>marked.markPendingBoundary(0),/markers/);
 for(const p of [marked,plain])p.move([20,0,0,1],100);const count=marked.pending;assert(marked.markPendingBoundary(5));assert.equal(marked.pending,count);
 const a=marked.flush(),b=plain.flush();assert(a.length>1);assert(a.slice(0,-1).every(m=>m.endMarkers===undefined));assert.deepEqual(a.at(-1)!.endMarkers,[5]);assert.deepEqual(a.map(m=>m.profile),b.map(m=>m.profile));
});
test('marker identities are bounded, dense, unique and immutable',()=>{
 const m=path()[0];assert.throws(()=>markMoveEnd(m,1),/markers/);for(const id of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>markMoveEnd(m,id));
 for(const ids of [new Array(1),[1,1],Array.from({length:65},(_,i)=>i+1)])assert.throws(()=>validateEndMarkers(ids));
 assert.deepEqual(m.endMarkers,[1]);assert(Object.isFrozen(m.endMarkers));
});
for(const filtered of [false,true])test(`source owns marker times through braking and resume (filtered=${filtered})`,async()=>{
 const f=idleMotionFixture(filtered);try{
  const q=new LookAheadQueue(),m=new Move(motionLimits(100,100,5,0),[50,0,0,2],[60,0,0,3],10),ids=[7];m.endMarkers=ids;q.add(m);f.source.startAt(1);f.source.append(q.flush());ids[0]=99;
  assert.deepEqual(f.source.boundarySchedule(),[{id:7,time:f.source.status.sourceTime}]);await f.source.flushThrough(1.4,signal());const stop=await f.source.brakeAt(1.6,signal());assert.deepEqual(f.source.boundarySchedule(),[]);assert.deepEqual(stop.remainder[0].endMarkers,[7]);
  await f.source.drain([],signal());f.source.resumeAt(3);const restart=new LookAheadQueue();restart.addBatch(stop.remainder);f.source.append(restart.flush());assert.deepEqual(f.source.boundarySchedule(),[{id:7,time:f.source.status.sourceTime}]);assert(f.source.status.sourceTime>3);
  await f.source.drain([],signal());assert.deepEqual(f.positions,{x:1100n,e:120n});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('streamer snapshots marker arrays before asynchronous native submission',async()=>{
 const f=await rebuiltFixture();try{
  const g=await bindRebuiltMotion(f.options),stream=new RebuiltMotionStreamer(g),q=new LookAheadQueue(),m=new Move(motionLimits(100,1000),[50,0,0,2],[51,0,0,2],10),ids=[11];m.endMarkers=ids;q.add(m);
  const seen:number[][]=[],append=g.source.append.bind(g.source);g.source.append=moves=>{seen.push(...moves.filter(m=>m.endMarkers).map(m=>[...m.endMarkers!]));append(moves);};
  const pending=stream.append(q.flush(),signal());ids[0]=99;await pending;assert.deepEqual(seen,[[11]]);await g.source.drain([],signal());assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,200n);
 }finally{await f.close();}
});
