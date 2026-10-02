import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {PrintJournal} from '../src/operations/print-journal.ts';
const root=await mkdtemp(join(tmpdir(),'statistics-bench-')),samples:number[][]=[[],[]],jobs=100;
const snapshot={totalDuration:120,printDuration:100,filamentUsed:12.5};
try{
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
  const path=join(root,`${run}-${variant}.db`),journal=await PrintJournal.open({path,deviceId:'bench'});let elapsed=0;
  try{for(let i=0;i<jobs;i++){const id='job'+i;await journal.reserve({version:1,requestId:id,fileId:'file',nozzle:0,bed:0});await journal.transition(id,1,'started');const start=performance.now();await journal.transition(id,2,'completed',variant?snapshot:undefined);elapsed+=performance.now()-start;}}finally{await journal.close();}
  const db=new DatabaseSync(path,{readOnly:true});try{assert.equal(db.prepare("SELECT count(*) AS n FROM requests WHERE state='completed' AND revision=3").get()!.n,jobs);const records=db.prepare('SELECT statistics FROM request_statistics').all();assert.equal(records.length,variant?jobs:0);for(const record of records)assert.deepEqual(JSON.parse(String(record.statistics)),snapshot);}finally{db.close();}
  if(run>=3)samples[variant].push(elapsed/jobs);
 }
 const results=samples.map(values=>{values.sort((a,b)=>a-b);return {medianMs:values[5],p95Ms:values[10]};});const addedP95Ms=results[1].p95Ms-results[0].p95Ms;assert(addedP95Ms<2,JSON.stringify({results,addedP95Ms}));
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(root).type,variants:['terminalStateOnly','terminalStateAndStatistics'],jobs,warmups:3,runs:11,results,addedP95Ms,maximumAddedP95Ms:2,scope:'Acknowledged terminal transaction IPC and durable commit, not per-move work. Same current schema in both variants. Read-only SQLite verification outside timing; no physical target guarantee.'}));
}finally{await rm(root,{recursive:true,force:true});}
