import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalUserAuthorization} from '../src/moonraker/local-user-authorization.ts';
import {DatabaseStore} from '../src/moonraker/database.ts';
const root=await mkdtemp(join(tmpdir(),'jwt-bench-')),db=await DatabaseStore.open({path:join(root,'auth.sqlite')});let now=10000;
const users=await LocalUserAuthorization.open(db,{issuer:'http://printer.test',now:()=>now}),signal=new AbortController().signal;
try{
 const a=await users.login({username:'bench',password:'benchmark'},signal,true),samplesMs:number[]=[];
 for(let round=0;round<8;round++){const start=performance.now();for(let i=0;i<100000;i++)assert.equal(users.decode(a.token).username,'bench');if(round>=3)samplesMs.push(performance.now()-start);}
 const tokens:string[]=[];for(let i=0;i<2000;i++){now++;tokens.push(users.refresh(a.refresh_token).token);}
 const coldStart=performance.now();for(const token of tokens)assert.equal(users.decode(token).username,'bench');const coldMicroseconds=(performance.now()-coldStart)/2;
 const warmMicroseconds=[...samplesMs].sort((a,b)=>a-b)[2]/100;
 let ticks=0,last=performance.now(),maxTimerGapMs=0;const timer=setInterval(()=>{const current=performance.now();maxTimerGapMs=Math.max(maxTimerGapMs,current-last);last=current;ticks++;},1),loginStart=performance.now();
 try{for(let i=0;i<20;i++)await users.login({username:'bench',password:'benchmark'},signal);}finally{clearInterval(timer);}
 const loginTotalMs=performance.now()-loginStart;
 assert(warmMicroseconds<10,'Warm JWT validation exceeds development budget');assert(coldMicroseconds<500,'Cold Ed25519 validation exceeds development budget');assert(ticks>20,'Password hashing starved event loop');assert(maxTimerGapMs<50,'Password hashing blocked event loop beyond development budget');
 console.log(JSON.stringify({runtime:process.version,scope:'Desktop development regression only, no Python comparison or concurrent print proof',samplesMs,warmMicroseconds,coldMicroseconds,loginTotalMs,loginCount:20,ticks,maxTimerGapMs,budgets:{warmMicroseconds:10,coldMicroseconds:500,maxTimerGapMs:50}},null,2));
}finally{await users.close();await db.close();await rm(root,{recursive:true,force:true});}
