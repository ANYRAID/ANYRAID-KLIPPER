import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
/** Independent read-only SQL verification after the worker has closed. */
export function verifyJournalRows(path:string,jobs:number,nozzle:number,bed:number):void{
 const raw=new DatabaseSync(path,{readOnly:true});
 try{
  const rows=raw.prepare('SELECT id,request,state,revision FROM requests').all();assert.equal(rows.length,jobs);const ids=new Set(rows.map(row=>row.id));assert.equal(ids.size,jobs);for(let i=0;i<jobs;i++)assert(ids.has('job'+i));
  for(const row of rows){assert.equal(row.state,'completed');assert.equal(row.revision,3);assert.deepEqual(JSON.parse(String(row.request)),{version:1,requestId:row.id,fileId:'file',nozzle,bed});}
 }finally{raw.close();}
}
