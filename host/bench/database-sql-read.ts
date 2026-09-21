import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {DatabaseEngine} from '../src/moonraker/database-engine.ts';
import type {SqlResult} from '../src/moonraker/database-sql.ts';
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'sql-read-cost-')),engine=new DatabaseEngine({path:join(root,'direct')}),worker=await DatabaseStore.open({path:join(root,'worker')});
try{
 const definition={name:'probe',prototype:'probe (id INTEGER PRIMARY KEY, value REAL)',version:1};
 engine.registerTable(definition);await worker.registerTable(definition);engine.sealTableRegistration();await worker.sealTableRegistration();
 const insert=[{sql:'INSERT INTO probe VALUES(1,2.675)'}];engine.sql(['probe'],insert);await worker.sql(['probe'],insert);
 const query={sql:'SELECT id,value FROM probe WHERE id=?',params:[1]};
 const variants:Record<string,()=>SqlResult|Promise<SqlResult>>={engineTransaction:()=>engine.sql(['probe'],[query])[0],engineRead:()=>engine.sqlRead(['probe'],query),workerTransaction:async()=>(await worker.sql(['probe'],[query]))[0],workerRead:()=>worker.sqlRead(['probe'],query)};
 const samples:Record<string,number[]>={};for(const name of Object.keys(variants))samples[name]=[];
 for(let round=0;round<9;round++)for(const name of round%2?Object.keys(variants).reverse():Object.keys(variants)){let last:SqlResult|undefined;const start=performance.now();for(let i=0;i<500;i++)last=await variants[name]();const elapsed=performance.now()-start;assert.deepEqual(last?.rows,[[1,2.675]]);if(round>=2)samples[name].push(elapsed);}
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(root).type,requestsPerRound:500,summary:Object.fromEntries(Object.entries(samples).map(([name,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [name,{medianMs:sorted[3],p95Ms:sorted[6]}];})),scope:'Indexed two-column SELECT; direct engine is a lower bound. Worker paths additionally include admission, request/response validation, structured cloning, messaging and scheduling, not just IPC. No metadata serialization, network or hardware.'},null,2));
}finally{engine.close();await worker.close();await rm(root,{recursive:true,force:true});}
