// Compare with the exact pre-change dispatcher; not a network/auth-provider benchmark.
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {setImmediate as immediate} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
const pin='d944df75',root=fileURLToPath(new URL('../../',import.meta.url));
const file=new URL('../node_modules/.cache/authorization-baseline.mjs',import.meta.url);
mkdirSync(new URL('./',file),{recursive:true});
const source=execFileSync('git',['show',`${pin}:host/src/moonraker/rpc.ts`],{cwd:root,encoding:'utf8'});
writeFileSync(file,stripTypeScriptTypes(source).replace("'./json.ts'",JSON.stringify(new URL('../src/moonraker/json.ts',import.meta.url).href)));
try{
 const Original=(await import(pathToFileURL(fileURLToPath(file)).href)).JsonRpcDispatcher;
 const count=20000,input=JSON.stringify({jsonrpc:'2.0',method:'echo',id:1,params:{value:42}}),signal=new AbortController().signal;
 const cases=[['before',Original,()=>{}],['afterAnonymous',JsonRpcDispatcher,()=>{}],['afterIdentity',JsonRpcDispatcher,()=>({username:'alice'})]] as const;
 const results:Record<string,number[]>={before:[],afterAnonymous:[],afterIdentity:[]};
 for(let round=0;round<9;round++){
  const order=round%2?[...cases].reverse():cases;
  for(const [name,Constructor,authorize] of order){const rpc=new Constructor();rpc.register('echo',['websocket'],(p:any)=>p);const context={transport:'websocket' as const,signal,authorize};let reply:string|null=null;const start=performance.now();
   for(let i=0;i<count;i++){reply=await rpc.dispatch(input,context);if(i%250===249)await immediate();}
   const elapsed=performance.now()-start;assert.equal(JSON.parse(reply!).result.value,42);if(round>=2)results[name].push(elapsed);
  }
 }
 const summary=Object.fromEntries(Object.entries(results).map(([name,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [name,{medianMs:sorted[3],p95Ms:sorted[6],roundsMs:values}];}));
 console.log(JSON.stringify({node:process.version,baseline:pin,count,warmupRounds:2,measuredRounds:7,yieldEvery:250,summary},null,2));
}finally{rmSync(file,{force:true});}
