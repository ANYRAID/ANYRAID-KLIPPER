import assert from 'node:assert/strict';
import {OneShotTokens} from '../src/moonraker/authorization-policy.ts';
const tokens=new OneShotTokens<number>(),samplesMs:number[]=[];
try{
 for(let round=0;round<8;round++){const start=performance.now();for(let i=0;i<10000;i++){const token=tokens.issue('127.0.0.1',i);assert.equal(tokens.consume(token,'127.0.0.1'),i);}if(round>=3)samplesMs.push(performance.now()-start);}
 const microsecondsPerPair=[...samplesMs].sort((a,b)=>a-b)[2]/10;assert(microsecondsPerPair<20,'One-shot issuance and consumption exceed desktop budget');assert.equal(tokens.count,0);
 console.log(JSON.stringify({runtime:process.version,scope:'10000 random 20-byte token issue/consume pairs per round; 3 warmups and 5 retained rounds; no IO, Python comparison or printing',samplesMs,microsecondsPerPair,budgetMicroseconds:20},null,2));
}finally{tokens.close();}
