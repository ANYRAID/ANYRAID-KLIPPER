import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
async function fixture(run:(db:DatabaseStore,path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'sql-read-')),path=join(dir,'db'),db=await DatabaseStore.open({path,maxReplyBytes:8192});try{await db.registerTable({name:'jobs',prototype:'jobs (id INTEGER PRIMARY KEY, value, other BLOB)',version:1});await db.registerTable({name:'other_jobs',prototype:'other_jobs (value)',version:1});await db.sealTableRegistration();await run(db,path);}finally{await db.close();await rm(dir,{recursive:true,force:true});}}
test('read-only statements preserve exact integers, floating values, blobs and duplicate columns',()=>fixture(async db=>{
 const id={integer:'9223372036854775807'},blob={blob:'AP+A'};await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(?,?,?)',params:[id,{real:1e20},blob]}]);
 const query={sql:'SELECT id,value,other,NULL,id AS value FROM jobs WHERE id=?',params:[id]};assert.deepEqual(await db.sqlRead(['jobs'],query),(await db.sql(['jobs'],[query]))[0]);
 assert.deepEqual((await db.sqlRead(['jobs'],{sql:'SELECT value FROM jobs'})).rows,[[1e20]]);
 await assert.rejects(db.sqlRead(['jobs'],{sql:'SELECT ?',params:[1e20]}),e=>e instanceof ApiError&&e.status===400);
}));
test('read-only authorization rejects writes, DDL, pragmas, transactions, extensions and undeclared tables',()=>fixture(async db=>{
 await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(1,2,NULL)'}]);
 for(const sql of ['INSERT INTO jobs VALUES(2,3,NULL) RETURNING *','UPDATE jobs SET value=9 RETURNING *','DELETE FROM jobs RETURNING *','CREATE TABLE unwanted (x)','DROP TABLE jobs','PRAGMA journal_mode','BEGIN','COMMIT',"ATTACH ':memory:' AS another",'SELECT * FROM other_jobs','SELECT * FROM namespace_store',"SELECT load_extension('missing')",'SELECT 1; DELETE FROM jobs'])await assert.rejects(db.sqlRead(['jobs'],{sql}));
 assert.deepEqual((await db.sqlRead(['jobs'],{sql:'SELECT * FROM jobs'})).rows,[[1,2,null]]);
 await assert.rejects(db.sqlRead(['namespace_store'],{sql:'SELECT 1'}),e=>e instanceof ApiError&&e.status===400);
 await db.sql(['jobs'],[{sql:'UPDATE jobs SET value=3'}]);assert.deepEqual((await db.sqlRead(['jobs'],{sql:'SELECT value FROM jobs'})).rows,[[3]]);
}));
test('WAL reads do not request a write lock and see an external commit without cached results',()=>fixture(async(db,path)=>{
 await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(1,2,NULL)'}]);const external=new DatabaseSync(path);let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  external.exec('BEGIN IMMEDIATE; UPDATE jobs SET value=9');
  const reply=await Promise.race([db.sqlRead(['jobs'],{sql:'SELECT value FROM jobs'}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Read waited for the writer lock')),1000);})]);clearTimeout(timer);
  assert.deepEqual(reply.rows,[[2]]);external.exec('COMMIT');assert.deepEqual((await db.sqlRead(['jobs'],{sql:'SELECT value FROM jobs'})).rows,[[9]]);
 }finally{clearTimeout(timer);external.close();}
}));
test('read response limits, invariants and lifecycle checks remain enforced',()=>fixture(async db=>{
 await assert.rejects(db.sqlRead(['jobs'],{sql:'SELECT zeroblob(10000)'}),e=>e instanceof ApiError&&e.status===413);
 await assert.rejects(db.sqlRead(['jobs'],{sql:'SELECT 1',expectRows:0}),e=>e instanceof ApiError&&e.status===409);
 await assert.rejects(db.sqlRead(['jobs'],{sql:'SELECT 1',many:[[]]}),e=>e instanceof ApiError&&e.status===400);
 assert.deepEqual((await db.sqlRead(['jobs'],{sql:'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3) SELECT sum(x) FROM n'})).rows,[[6]]);
 await db.close();await assert.rejects(db.sqlRead(['jobs'],{sql:'SELECT 1'}),e=>e instanceof ApiError&&e.status===503);
}));

test('warm read plans cannot cross declared table scopes or reuse old parameter bindings',()=>fixture(async db=>{
 await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(1,2,NULL)'}]);
 const sql='SELECT id,value FROM jobs WHERE id=?';
 assert.deepEqual((await db.sqlRead(['jobs','other_jobs'],{sql,params:[1]})).rows,[[1,2]]);
 await assert.rejects(db.sqlRead(['other_jobs'],{sql,params:[1]}));
 assert.deepEqual((await db.sqlRead(['JOBS'],{sql,params:[2]})).rows,[]);
 assert.deepEqual((await db.sqlRead(['jobs'],{sql,params:[1]})).rows,[[1,2]]);
 assert.deepEqual((await db.sqlRead(['jobs'],{sql:'SELECT ?',params:[7]})).rows,[[7]]);
 assert.deepEqual((await db.sqlRead(['jobs'],{sql:'SELECT ?'})).rows,[[null]]);
 await assert.rejects(db.sqlRead(['jobs'],{sql:'SELECT ?',params:['x'.repeat(10000)]}),e=>e instanceof ApiError&&e.status===413);
 assert.deepEqual((await db.sqlRead(['jobs'],{sql:'SELECT ?',params:[9]})).rows,[[9]]);
}));
test('external schema changes refresh column metadata and reauthorize cached statements',()=>fixture(async(db,path)=>{
 await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(1,2,NULL)'}]);const query={sql:'SELECT * FROM jobs'};
 assert.deepEqual((await db.sqlRead(['jobs'],query)).columns,['id','value','other']);const external=new DatabaseSync(path);
 try{
  external.exec("ALTER TABLE jobs ADD COLUMN added TEXT DEFAULT 'new'");const altered=await db.sqlRead(['jobs'],query);assert.deepEqual(altered.columns,['id','value','other','added']);assert.deepEqual(altered.rows,[[1,2,null,'new']]);
  external.exec('ALTER TABLE jobs ADD COLUMN "'+'q'.repeat(9000)+'" INTEGER');await assert.rejects(db.sqlRead(['jobs'],query),e=>e instanceof ApiError&&e.status===413);
  external.exec('DROP TABLE jobs; CREATE VIEW jobs AS SELECT * FROM other_jobs');await assert.rejects(db.sqlRead(['jobs'],query));
  external.exec('DROP VIEW jobs; CREATE TABLE jobs (different TEXT); INSERT INTO jobs VALUES(\'ok\')');const replaced=await db.sqlRead(['jobs'],query);assert.deepEqual(replaced.columns,['different']);assert.deepEqual(replaced.rows,[['ok']]);
 }finally{external.close();}
}));
test('later table registration cannot remove the read plan authorization boundary',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'read-plan-register-')),db=await DatabaseStore.open({path:join(directory,'db')});
 try{await db.registerTable({name:'first_table',prototype:'first_table (id INTEGER)',version:1});await db.sqlRead(['first_table'],{sql:'SELECT * FROM first_table'});
  await db.registerTable({name:'second_table',prototype:'second_table (id INTEGER)',version:1});await db.sqlRead(['first_table'],{sql:'SELECT * FROM first_table'});await assert.rejects(db.sqlRead(['first_table'],{sql:'SELECT * FROM second_table'}));
  await assert.rejects(db.sqlRead(['first_table'],{sql:'INSERT INTO first_table VALUES(1)'}));
 }finally{await db.close();await rm(directory,{recursive:true,force:true});}
});

test('read plan eviction finalizes old native statements and closing releases retained plans',async()=>{
 const {executeSql,releaseSqlPlans}=await import('../src/moonraker/database-sql.ts'),db=new DatabaseSync(':memory:'),held:ReturnType<DatabaseSync['prepare']>[]=[];
 db.exec('CREATE TABLE jobs (id INTEGER)');const prepare=db.prepare.bind(db);db.prepare=(sql:string)=>{const s=prepare(sql);if(sql.startsWith('SELECT 1 AS column_')||sql.includes('oversized_binding'))held.push(s);return s;};
 try{for(let i=0;i<40;i++)assert.deepEqual(executeSql(db,['jobs'],[{sql:`SELECT 1 AS column_${i}`}],new Set(['jobs']),8192,true)[0].rows,[[1]]);
  assert.deepEqual(executeSql(db,['jobs'],[{sql:'SELECT length(?) AS oversized_binding',params:['x'.repeat(10000)]}],new Set(['jobs']),8192,true)[0].rows,[[10000]]);assert.throws(()=>held.pop()!.get());
  assert.throws(()=>held[0].get());assert.deepEqual(held.at(-1)!.get(),[1n]);releaseSqlPlans(db);assert.throws(()=>held.at(-1)!.get());
 }finally{releaseSqlPlans(db);db.close();}
});
