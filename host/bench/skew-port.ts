import assert from 'node:assert/strict';
import {SkewCorrection} from '../src/motion/skew.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const enabled=new SkewCorrection({xy:.001,xz:.002,yz:.003});
const results:{plain:number[];skew:number[]}={plain:[],skew:[]};
for(let batch=0;batch<11;batch++)for(const kind of (batch%2?['skew','plain']:['plain','skew']) as ('plain'|'skew')[]){
 const port=new BedMeshMovePort({skew:kind==='skew'?enabled:undefined,mesh:null,physicalPosition:[0,0,0,0],limits:motionLimits(100,1000),validate:()=>{}});let count=0;
 const start=performance.now();for(let i=0;i<10000;i++){port.move([10+i%100,20+i%31,5+i%7,0],50);if(i%32===31)count+=port.flush().length;}count+=port.flush().length;const ms=performance.now()-start;
 assert.equal(count,10000);const expected=[109,37,8,0];assert.deepEqual(port.plannedPosition,kind==='skew'?enabled.apply(expected):expected);if(batch>=2)results[kind].push(ms);
}
console.log(JSON.stringify({node:process.version,moves:10000,warmups:2,samples:9,order:'alternating',results:Object.fromEntries(Object.entries(results).map(([kind,values])=>{values.sort((a,b)=>a-b);return [kind,{medianMs:values[4],maxMs:values[8]}];})),scope:'Host admission and lookahead flush, synchronous no-op validator; no MCU I/O.'}));
