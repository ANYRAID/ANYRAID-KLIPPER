import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshFade} from '../src/motion/bed-mesh-fade.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {createGuardedBedMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {TemperatureState} from '../src/thermal/state.ts';
import {GCodeMove} from '../src/gcode/move.ts';
const mesh=new BedMesh({min_x:0,max_x:200,min_y:0,max_y:200,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[0,.5],[-.2,.3]]);
const samples:number[][]=[[],[]];let segments=0,permissionReads=0,guardedReads=0;const checksums:number[]=[];
for(let k=0;k<16;k++)for(const guarded of k%2?[true,false]:[false,true]){const kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[-1,200]],maxVelocity:300,maxAccel:3000,maxZVelocity:20,maxZAccel:1000});kinematics.markHomed([0,1,2]);const extrusion=new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:25,maxAccel:500,maxDistance:50,instantCornerVelocity:1});const thermal=new TemperatureState({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1});thermal.sample(1,200);permissionReads=0;const common={mesh,fade:new BedMeshFade({start:1,end:10,target:0}),physicalPosition:[0,0,0,0],limits:motionLimits(300,3000)};const port=guarded?createGuardedBedMeshPort({...common,kinematics,extrusion,canExtrude:()=>{permissionReads++;return thermal.status(1).canExtrude;}}):new BedMeshMovePort({...common,validate:()=>{}});const g=new GCodeMove(port);segments=0;let checksum=0;const start=performance.now();for(let i=0;i<10000;i++){g.execute('G1',{X:i%2?0:200,Y:(i%5)*40,E:(i+1)*.01,F:6000});if(i%25===24)for(const m of port.flush()){segments++;checksum+=m.profile!.accelT+m.profile!.cruiseT+m.profile!.decelT;}}if(k>=5)samples[guarded?1:0].push(performance.now()-start);if(guarded){assert.equal(permissionReads,segments);guardedReads=permissionReads;}checksums[guarded?1:0]=checksum;assert.equal(port.pending,0);}
assert.ok(Math.abs(checksums[0]-checksums[1])<1e-9);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,commands:10000,segments,permissionReads:guardedReads,unguarded:stats(samples[0]),guarded:stats(samples[1]),durationChecksumError:Math.abs(checksums[0]-checksums[1]),scope:'Alternating order, five warmup and eleven measured batches; full G-code mesh planning/flush. Guarded path uses homed Cartesian checks, ExtrusionGuard admission/junction and live TemperatureState lookup per segment. Valid small-extrusion workload; excludes construction and hardware.'},null,2));
