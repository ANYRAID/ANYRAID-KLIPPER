import assert from 'node:assert/strict';
import {LinearKinematics,type LinearConfig} from '../src/kinematics/linear.ts';
import {DualCarriageLinearKinematics} from '../src/kinematics/dual-carriage-linear.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
const config:LinearConfig={kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100};
const geometry={kind:'cartesian',axis:0,rails:[{minimum:0,maximum:200,endstop:0,positiveDirection:false},{minimum:10,maximum:220,endstop:220,positiveDirection:true}],safeDistance:10} as const;
const base=new LinearKinematics(config),dual=new DualCarriageLinearKinematics(config,geometry,[{mode:'PRIMARY',scale:1,offset:0},{mode:'MIRROR',scale:-1,offset:230}]);base.markHomed([0,1,2]);dual.markHomed([0,1,2]);const mirror=dual.carriages;dual.commitCarriages([{mode:'INACTIVE',scale:0,offset:50},{mode:'PRIMARY',scale:1,offset:0}]);dual.markHomed([0]);dual.commitCarriages(mirror);
const limits=motionLimits(100,1000),samples:Record<string,number[]>={linear:[],dual:[]};
for(let run=0;run<8;run++)for(const name of run%2?['linear','dual']:['dual','linear']){
 const k=name==='linear'?base:dual,start=performance.now();let sum=0;
 for(let i=0;i<100000;i++){const move=new Move(limits,[50,0,0,0],[50.125+(i%8)/8,0,0,0],10);k.check(move);sum+=move.endPos[0];}
 assert.equal(sum,5056250);if(run>=3)samples[name].push(performance.now()-start);
}
console.log(JSON.stringify({runtime:process.version,scope:'100000 Move allocations plus live admission; alternating single carriage / mirror collision-range checks, no MCU IO',results:Object.fromEntries(Object.entries(samples).map(([name,values])=>[name,{samplesMs:values,medianMs:[...values].sort((a,b)=>a-b)[2]}]))},null,2));
