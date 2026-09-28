import assert from 'node:assert/strict';
import {dualCarriagePosition,type CarriageTopology} from '../src/kinematics/dual-carriage-projection.ts';
import type {CarriagePair} from '../src/kinematics/dual-carriage.ts';
const pair:CarriagePair=[{mode:'INACTIVE',scale:0,offset:0},{mode:'PRIMARY',scale:1,offset:0}];
const results=[];
for(const kind of ['cartesian','hybrid_corexy','hybrid_corexz'] as const){
 const topology:CarriageTopology={kind,axis:0},samples:number[]=[],iterations=100000;
 for(let run=0;run<7;run++){
  const start=performance.now();let checksum=0;
  for(let i=0;i<iterations;i++){const x=(i%256)/8,y=(i%97)/8,z=(i%47)/8,motor=kind==='hybrid_corexy'?x+y:kind==='hybrid_corexz'?x+z:x;checksum+=dualCarriagePosition(topology,pair,[0,y,z,motor])[0];}
  const elapsed=performance.now()-start;let expected=0;for(let i=0;i<iterations;i++)expected+=(i%256)/8;assert.equal(checksum,expected);
  if(run>=2)samples.push(elapsed);
 }
 const medianMs=[...samples].sort((a,b)=>a-b)[2];results.push({kind,iterations,samples,medianMs,projectionsPerSecond:iterations*1000/medianMs});
}
console.log(JSON.stringify({runtime:process.version,scope:'Validated four-motor logical coordinate readback, second carriage primary; no MCU IO or homing authority',results},null,2));
