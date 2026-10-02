import test from 'node:test';
import assert from 'node:assert/strict';
import {SkewCorrection} from '../src/motion/skew.ts';
import {BedTilt} from '../src/motion/bed-tilt.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {createGuardedBedMeshPort} from '../src/motion/guarded-bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {readLinearMotionConfiguration} from '../src/config/linear-motion.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
const skew=new SkewCorrection({xy:.1,xz:.02,yz:.03});
const options=()=>({skew,mesh:null,physicalPosition:[0,0,0,0],limits:motionLimits(100,1000),validate:()=>{}});
const near=(a:readonly number[],b:readonly number[])=>a.forEach((v,i)=>assert(Math.abs(v-b[i])<1e-12,`${i}: ${v} != ${b[i]}`));
test('skew precedes tilt and mesh and inverse reverses both transforms',async()=>{
 const target=[20,10,5,1],tilt=new BedTilt({x:.1,y:.02,z:0}),port=new BedMeshMovePort({...options(),tilt});
 port.move(target,10);near(port.plannedPosition,tilt.apply(skew.apply(target)));near(port.position(),target);
 const mesh=new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[0,.2],[0,.2]]);
 const meshed=new BedMeshMovePort({...options(),mesh});meshed.move(target,10);const corrected=skew.apply(target);corrected[2]+=mesh.calcZ(corrected[0],corrected[1]);near(meshed.plannedPosition,corrected);near(meshed.position(),target);assert(meshed.pending>1);
 await meshed.replaceMesh(null,{},async()=>{});near(meshed.position(),skew.unapply(corrected));near(meshed.plannedPosition,corrected);
});
test('physical limits reject skewed endpoint atomically, preserving queued motion and logical position',()=>{
 const config=readLinearMotionConfiguration(linearMotionReader());config.kinematics.markHomed([0,1,2]);
 const port=createGuardedBedMeshPort({...options(),kinematics:config.kinematics,extrusion:config.extrusion,canExtrude:()=>true,limits:config.limits}),gcode=new GCodeMove(port);
 gcode.execute('G1',{X:20,Y:10,Z:5,F:600});const count=port.pending,physical=port.plannedPosition,logical=gcode.state.position;
 assert.throws(()=>gcode.execute('G1',{X:0,Y:100}),/range/);assert.equal(port.pending,count);assert.deepEqual(port.plannedPosition,physical);assert.deepEqual(gcode.state.position,logical);
});
test('skew replacement waits for old moves and rebases without physical displacement',async()=>{
 const port=new BedMeshMovePort(options());port.move([20,10,5,1],10);const physical=port.plannedPosition;let release!:()=>void;
 const pending=port.replaceSkew(undefined,async moves=>{assert.equal(moves.length,1);near(moves[0].endPos,physical);await new Promise<void>(resolve=>{release=resolve;});});
 assert.throws(()=>port.move([30,10,5,1],10),/active/);assert.throws(()=>port.position(),/active/);release();near(await pending,physical);near(port.plannedPosition,physical);assert.equal(port.pending,0);port.move(physical,10);assert.equal(port.pending,0);
});
test('failed or cancelled skew transition latches admission shutdown',async()=>{
 const port=new BedMeshMovePort(options());port.move([20,10,5,1],10);await assert.rejects(port.replaceSkew(undefined,async()=>{throw new Error('drain failed');}),/drain failed/);assert.throws(()=>port.flush(),/drain failed/);
 const abort=new AbortController(),other=new BedMeshMovePort(options());await assert.rejects(other.replaceSkew(undefined,async()=>{abort.abort(new Error('cancel'));},abort.signal),/cancel/);assert.throws(()=>other.move([1,1,1,0],10),/cancel/);
});
