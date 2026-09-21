import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshFade} from '../src/motion/bed-mesh-fade.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {GCodeMove} from '../src/gcode/move.ts';
const mesh=new BedMesh({min_x:0,max_x:200,min_y:0,max_y:200,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[0,.5],[-.2,.3]]);
const times:number[]=[];let segments=0,checksum=0;
for(let k=0;k<16;k++){const port=new BedMeshMovePort({mesh,fade:new BedMeshFade({start:1,end:10,target:0}),physicalPosition:[0,0,0,0],limits:motionLimits(300,3000),validate:move=>{assert.ok(move.endPos.slice(0,2).every(v=>v>=0&&v<=200));}}),gcode=new GCodeMove(port);segments=0;checksum=0;const start=performance.now();for(let i=0;i<10000;i++){gcode.execute('G1',{X:i%2?0:200,Y:(i%5)*40,F:6000});if(i%25===24){for(const move of port.flush()){segments++;checksum+=move.profile!.cruiseT+move.profile!.accelT+move.profile!.decelT;}}}if(k>=5)times.push(performance.now()-start);assert.equal(port.pending,0);assert.equal(gcode.state.position[0],0);assert.ok(Number.isFinite(checksum));}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,commands:10000,segments,checksum,medianMs:times[5],p95Ms:times[10],scope:'GCodeMove -> fixed mesh/fade -> splitting -> per-segment XY guard -> atomic lookahead -> full trapezoid flush. Five warmup, eleven measured batches. Construction and hardware excluded; guard is benchmark-only, not complete kinematic/thermal acceptance.'},null,2));
