import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {StepHistory} from '../src/motion/step-history.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),helper=join(root,'klippy/chelper'),dir=mkdtempSync(join(tmpdir(),'step-history-'));
function run(command:string,args:string[]){const p=spawnSync(command,args,{encoding:'utf8',timeout:30000});if(p.status!==0)throw new Error(p.stderr||String(p.error));return p.stdout;}
try{
 const exe=join(dir,'reference');run(process.env.CC??'cc',['-O2',`-I${helper}`,`-DSTEP_SOURCE=${JSON.stringify(join(helper,'stepcompress.c'))}`,join(root,'host/bench/fixtures/step-history.c'),join(helper,'msgblock.c'),join(helper,'pyhelper.c'),'-lm','-pthread','-o',exe]);
 for(const rows of [32,4096]){
  const data=new BigInt64Array(rows*6),starts:bigint[]=[],base=1n<<54n;let first=base,pos=0n;
  for(let i=0;i<rows;i++){starts.push(first);const add=i%2?-2n:2n,count=i%2?-64n:64n,last=first+63000n+add*2016n;data.set([first,last,pos,count,1000n,add],(rows-i-1)*6);pos+=count;first=last+100n;}
  const lookups=Array.from({length:10000},(_,i)=>{const row=i*7919%rows,k=BigInt(i%64+1),add=row%2?-2n:2n;return starts[row]+(k-1n)*1000n+add*k*(k-1n)/2n;});
  const append:number[]=[],lookup:number[]=[],native:number[]=[];let expected:bigint|undefined;
  for(let round=0;round<14;round++){
   const ref=JSON.parse(run(exe,[String(rows)])) as {ms:number;sum:number};
   let start=performance.now();const history=new StepHistory(base-1n,0n);history.append({history:data,position:pos},first);const appendTime=performance.now()-start;
   start=performance.now();let sum=0n;for(const at of lookups)sum+=history.at(at);const lookupTime=performance.now()-start;
   assert.equal(sum,BigInt(ref.sum));if(expected!==undefined)assert.equal(sum,expected);expected=sum;
   if(round>=3){append.push(appendTime);lookup.push(lookupTime);native.push(ref.ms);}
  }
  for(const list of [append,lookup,native])list.sort((a,b)=>a-b);
  console.log(JSON.stringify({rows,lookups:10000,sum:String(expected),appendMedianMs:append[5],appendP95Ms:append[10],lookupMedianMs:lookup[5],lookupP95Ms:lookup[10],originalCMedianMs:native[5],originalCP95Ms:native[10],scope:'retained history only; C linked-list lookup baseline excludes Node-API; no print or homing throughput claim'}));
 }
}finally{rmSync(dir,{recursive:true,force:true});}
