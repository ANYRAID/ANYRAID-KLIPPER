import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {GCodeMove} from '../src/gcode/move.ts';
import type {Parameters} from '../src/gcode/move.ts';
const commands:{command:string;params:Parameters}[]=[];
for(let i=0;i<1000;i++)commands.push(
 {command:'G90',params:{}},{command:'M82',params:{}},{command:'G1',params:{X:i*.01,Y:i*.003,E:i*.002,F:1200}},
 {command:'SAVE_GCODE_STATE',params:{NAME:'cycle'}},{command:'G91',params:{}},{command:'M83',params:{}},
 {command:'G1',params:{X:.02,E:.001}},{command:'M220',params:{S:50+i%100}},{command:'M221',params:{S:80+i%40}},
 {command:'G92',params:{E:0}},{command:'SET_GCODE_OFFSET',params:{Z_ADJUST:.00001,MOVE:i%2}},
 {command:'RESTORE_GCODE_STATE',params:{NAME:'cycle',MOVE:1,MOVE_SPEED:20}}
);
const reference=JSON.parse(readFileSync(new URL('../contracts/gcode-move-reference.json',import.meta.url),'utf8')),data=readFileSync(new URL('../contracts/gcode-move-reference.json.gz',import.meta.url));
assert.equal(createHash('sha256').update(data).digest('hex'),reference.dataSha256);assert.equal(commands.length,reference.commands);
const oracle=JSON.parse(gunzipSync(data).toString());
function run(capture=false) {
 const moves:[number[],number][]=[],states:unknown[]=[];let position=[0,0,0,0];
 const engine=new GCodeMove({position:()=>position,move:(p,speed)=>{position=[...p];moves.push([position,speed]);}});
 for(const c of commands){engine.execute(c.command,c.params);if(capture){const s=engine.state;states.push([s.absoluteCoordinates,s.absoluteExtrude,s.base,s.position,s.homing,s.speed,s.speedFactor,s.extrudeFactor]);}}
 return {moves,states};
}
assert.deepEqual(run(true),oracle.result);
for(let i=0;i<3;i++)run();const times=[];
for(let i=0;i<11;i++){const start=performance.now();run();times.push(performance.now()-start);}times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,commands:commands.length,statesExact:true,moves:oracle.result.moves.length,nodeMedianMs:times[5],nodeP95Ms:times[10],historicalPythonMedianMs:oracle.times[5],historicalPythonP95Ms:oracle.times[10],sameReferenceCPU:cpus()[0].model===reference.cpu,speedup:oracle.times[5]/times[5]},null,2));
if(cpus()[0].model===reference.cpu)assert.ok(times[5]<=oracle.times[5],'Coordinate dispatch regressed against historical Python on this CPU');
