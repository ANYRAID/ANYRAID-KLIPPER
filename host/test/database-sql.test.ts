import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
async function fixture(run:(db:DatabaseStore)=>Promise<void>,maxReplyBytes=8192){
 const dir=await mkdtemp(join(tmpdir(),'sql-worker-'));let db:DatabaseStore|undefined;
 try{db=await DatabaseStore.open({path:join(dir,'db'),maxReplyBytes});await db.registerTable({name:'jobs',prototype:'jobs (id INTEGER PRIMARY KEY, value, other BLOB)',version:1});await db.registerTable({name:'totals',prototype:'totals (value INTEGER)',version:1});await db.sealTableRegistration();await run(db);}finally{await db?.close();await rm(dir,{recursive:true,force:true});}
}
test('SQL worker retains int64, real, blob, null and duplicate column values',()=>fixture(async db=>{
 const integer={integer:'9223372036854775807'},blob={blob:'AP+A'};
 const [insert,select]=await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(?,?,?)',params:[integer,2.675,blob]},{sql:'SELECT id,value,other,NULL,value AS id FROM jobs'}]);
 assert.deepEqual(insert,{columns:[],rows:[],changes:1,lastInsertRowid:integer});
 assert.deepEqual(select.columns,['id','value','other','NULL','id']);assert.deepEqual(select.rows,[[integer,2.675,blob,null,2.675]]);
 await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(?,?,?)',params:[1,{real:1e20},null]}]);
 assert.deepEqual((await db.sql(['jobs'],[{sql:'SELECT value FROM jobs WHERE id=1'}]))[0].rows,[[1e20]]);
 await assert.rejects(db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(?,?,?)',params:[2,1e20,null]}]),e=>e instanceof ApiError&&e.status===400);
}));
test('SQL batches commit across tables and roll back all writes on late failures',()=>fixture(async db=>{
 await db.sql(['jobs','totals'],[{sql:'INSERT INTO jobs VALUES(1,3,NULL)'},{sql:'INSERT INTO totals SELECT value FROM jobs'}]);
 await assert.rejects(db.sql(['jobs','totals'],[{sql:'UPDATE totals SET value=9'},{sql:'INSERT INTO jobs VALUES(1,4,NULL)'}]));
 const [result]=await db.sql(['totals'],[{sql:'SELECT * FROM totals'}]);assert.deepEqual(result.rows,[[3]]);
 await Promise.all(Array.from({length:20},()=>db.sql(['totals'],[{sql:'UPDATE totals SET value=value+1'},{sql:'UPDATE totals SET value=value+1'}])));
 assert.deepEqual((await db.sql(['totals'],[{sql:'SELECT * FROM totals'}]))[0].rows,[[43]]);
}));
test('SQL rejects undeclared tables, transaction and schema operations, and ignored trailing statements',()=>fixture(async db=>{
 await db.insert('ui','keep',1);
 for(const sql of ['COMMIT','PRAGMA writable_schema=ON',"ATTACH DATABASE ':memory:' AS attached",'DROP TABLE jobs','DELETE FROM namespace_store','SELECT * FROM namespace_store','INSERT INTO totals VALUES(1)','SELECT 1; DELETE FROM jobs']){
  await assert.rejects(db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(1,2,NULL)'},{sql}]));
  assert.deepEqual((await db.sql(['jobs'],[{sql:'SELECT * FROM jobs'}]))[0].rows,[]);
 }
 await assert.rejects(db.sql(['namespace_store'],[{sql:'SELECT 1'}]));
 assert.equal(await db.get('ui','keep'),1);
}));
test('SQL reply limits and nonfinite output roll back RETURNING writes',()=>fixture(async db=>{
 await assert.rejects(db.sql(['jobs'],[{sql:"INSERT INTO jobs VALUES(1,printf('%02000d',1),NULL) RETURNING value"}]),e=>e instanceof ApiError&&e.status===413);
 assert.deepEqual((await db.sql(['jobs'],[{sql:'SELECT id FROM jobs'}]))[0].rows,[]);
 await assert.rejects(db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(1,1e999,NULL) RETURNING value'}]),e=>e instanceof ApiError&&e.status===422);
 assert.deepEqual((await db.sql(['jobs'],[{sql:'SELECT id FROM jobs'}]))[0].rows,[]);
},512));
test('reused SQL rebinds every parameter and aggregate acknowledgement overflow rolls back',()=>fixture(async db=>{
 await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(?,?,?)',params:[1,'first',null]},{sql:'INSERT INTO jobs VALUES(?,?,?)',params:[2,'second',null]}]);
 assert.deepEqual((await db.sql(['jobs'],[{sql:'SELECT value FROM jobs ORDER BY id'}]))[0].rows,[['first'],['second']]);
 await assert.rejects(db.sql(['jobs'],Array.from({length:20},()=>({sql:"UPDATE jobs SET value='changed'"}))),e=>e instanceof ApiError&&e.status===413);
 assert.deepEqual((await db.sql(['jobs'],[{sql:'SELECT value FROM jobs ORDER BY id'}]))[0].rows,[['first'],['second']]);
},512));
test('SQL many aggregates changes, supports empty batches and rolls back a failed binding set',()=>fixture(async db=>{
 assert.deepEqual((await db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(?,?,?)',many:[[1,2.675,null],[2,'text',null]]}]))[0],{columns:[],rows:[],changes:2,lastInsertRowid:2});
 assert.deepEqual((await db.sql(['jobs'],[{sql:'DELETE FROM jobs WHERE id=?',many:[]}]))[0],{columns:[],rows:[],changes:0,lastInsertRowid:null});
 await assert.rejects(db.sql(['jobs'],[{sql:'INSERT INTO jobs VALUES(?,?,?)',many:[[3,4,null],[1,5,null]]}]));
 assert.deepEqual((await db.sql(['jobs'],[{sql:'SELECT id FROM jobs ORDER BY id'}]))[0].rows,[[1],[2]]);
 await assert.rejects(db.sql(['jobs'],[{sql:'SELECT * FROM jobs',many:[[]]}]),e=>e instanceof ApiError&&e.status===400);
}));
test('SQL bindings preserve INTEGER versus explicit REAL and both signed int64 endpoints',()=>fixture(async db=>{
 const low={integer:'-9223372036854775808'},high={integer:'9223372036854775807'};
 const [row]=await db.sql(['jobs'],[{sql:'SELECT typeof(?),typeof(?),?,?,typeof(?)',params:[1,{real:1},low,high,-0]}]);
 assert.deepEqual(row.rows,[['integer','real',low,high,'real']]);
 await assert.rejects(db.sql(['jobs'],[{sql:'SELECT ?',params:[{integer:'9223372036854775808'}]}]),e=>e instanceof ApiError&&e.status===400);
}));
