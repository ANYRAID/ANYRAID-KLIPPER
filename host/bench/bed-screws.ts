import assert from 'node:assert/strict';
import {initialBedScrewsState,planBedScrews} from '../src/homing/bed-screws.ts';
const plan={coarse:[0,1,2].map(i=>({position:[i,0] as [number,number],name:String(i)})),fine:[],horizontalHeight:5,contactHeight:0,travelSpeed:50,liftSpeed:5},times:number[]=[];let transitions=0;
for(let batch=0;batch<9;batch++){let state=initialBedScrewsState(),position=[0,0,0,0];const start=performance.now();for(let i=0;i<10000;i++){const next=planBedScrews(plan,state,state.phase==='idle'?'start':'accept',position);state=next.state;position=next.moves.at(-1)!.position;transitions++;}assert.equal(state.phase,'idle');if(batch>=2)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,iterations:10000,warmups:2,samples:7,medianMs:times[3],maxMs:times[6],transitions,scope:'Validated state transitions and travel planning; no physical movement or user interaction timing.'}));
