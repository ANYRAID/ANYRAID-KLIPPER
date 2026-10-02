import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {ApiError} from '../src/moonraker/rpc.ts';
async function directory(run:(path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'database-tables-'));try{await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const v1={name:'jobs',prototype:'jobs (id INTEGER PRIMARY KEY, value REAL NOT NULL)',version:1,migrations:{'0':['INSERT INTO jobs VALUES(1,2.675)']}};
const v2={name:'jobs',prototype:'jobs (id INTEGER PRIMARY KEY, value REAL NOT NULL, label TEXT NOT NULL DEFAULT \'old\')',version:2,migrations:{'1':["ALTER TABLE jobs ADD COLUMN label TEXT NOT NULL DEFAULT 'old'","UPDATE jobs SET label='migrated'"]}};
function read(path:string,sql:string){const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare(sql).all().map(row=>({...row}));}finally{db.close();}}
test('table creation, version upgrade and reopening preserve rows and reject duplicate owners',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{assert.deepEqual(await store.registerTable(v1),{name:'jobs',version:1,previousVersion:0,created:true,migrated:true});assert.deepEqual(read(path,'SELECT * FROM jobs'),[{id:1,value:2.675}]);await assert.rejects(store.registerTable(v1),e=>e instanceof ApiError&&e.status===409);await store.close();store=await DatabaseStore.open({path});assert.deepEqual(await store.registerTable(v2),{name:'jobs',version:2,previousVersion:1,created:false,migrated:true});assert.deepEqual(read(path,'SELECT * FROM jobs'),[{id:1,value:2.675,label:'migrated'}]);await store.close();store=await DatabaseStore.open({path});assert.deepEqual(await store.registerTable(v2),{name:'jobs',version:2,previousVersion:2,created:false,migrated:false});}finally{await store.close();}
}));
test('new table failure and failed upgrade roll back schema, rows, version and ownership',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{await assert.rejects(store.registerTable({...v1,migrations:{'0':['INSERT INTO jobs VALUES(1,1)','INSERT INTO missing VALUES(2)']}}));assert.deepEqual(read(path,"SELECT name FROM sqlite_schema WHERE name='jobs'"),[]);assert.deepEqual(read(path,"SELECT * FROM table_registry WHERE name='jobs'"),[]);await store.registerTable(v1);await store.close();store=await DatabaseStore.open({path});await assert.rejects(store.registerTable({...v2,migrations:{'1':[...v2.migrations['1'],'INSERT INTO missing VALUES(1)']}}));assert.deepEqual(read(path,'SELECT * FROM jobs'),[{id:1,value:2.675}]);assert.equal(read(path,"SELECT version FROM table_registry WHERE name='jobs'")[0].version,1);await store.registerTable(v2);}finally{await store.close();}
}));
test('migration cannot escape its transaction, attach files or change core tables',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite'),store=await DatabaseStore.open({path});try{await store.insert('ui','keep',1);for(const sql of ['COMMIT','PRAGMA writable_schema=ON',"ATTACH DATABASE ':memory:' AS other",'DELETE FROM namespace_store','DROP TABLE namespace_store','CREATE TABLE unrelated (id INT)']){await assert.rejects(store.registerTable({...v1,migrations:{'0':[sql]}}));assert.deepEqual(read(path,"SELECT name FROM sqlite_schema WHERE name='jobs'"),[]);assert.equal(await store.get('ui','keep'),1);}await store.registerTable(v1);}finally{await store.close();}
}));
test('missing upgrades, wrong resulting columns, downgrade and sealed initialization are rejected',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{await store.registerTable(v1);await store.close();store=await DatabaseStore.open({path});await assert.rejects(store.registerTable({...v2,migrations:{}}),e=>e instanceof ApiError&&e.status===409);await assert.rejects(store.registerTable({...v2,migrations:{'1':[]}}),e=>e instanceof ApiError&&e.status===409);await store.registerTable(v2);await store.close();store=await DatabaseStore.open({path});await assert.rejects(store.registerTable(v1),e=>e instanceof ApiError&&e.status===409);await store.sealTableRegistration();await assert.rejects(store.registerTable({name:'later',prototype:'later (id INT)',version:1}),e=>e instanceof ApiError&&e.status===409);await store.insert('ui','works',1);assert.equal(await store.get('ui','works'),1);}finally{await store.close();}
}));
test('schema drift and undersized acknowledgement cannot publish a successful registration',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{await store.registerTable(v1);await store.close();const raw=new DatabaseSync(path);raw.exec('ALTER TABLE jobs ADD COLUMN unexpected TEXT');raw.close();store=await DatabaseStore.open({path});await assert.rejects(store.registerTable(v1),e=>e instanceof ApiError&&e.status===409);}finally{await store.close();}
 const smallPath=join(dir,'small.sqlite'),small=await DatabaseStore.open({path:smallPath,maxReplyBytes:8});try{await assert.rejects(small.registerTable(v1),e=>e instanceof ApiError&&e.status===413);assert.deepEqual(read(smallPath,"SELECT name FROM sqlite_schema WHERE name='jobs'"),[]);}finally{await small.close();}
}));

test('case aliases cannot bypass the registered version or create a second registry entry',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{await store.registerTable(v2);await store.close();store=await DatabaseStore.open({path});await assert.rejects(store.registerTable({name:'Jobs',prototype:'Jobs (id INTEGER PRIMARY KEY, value REAL)',version:1,migrations:{'0':[]}}),e=>e instanceof ApiError&&e.status===409);assert.deepEqual(read(path,'SELECT name,version FROM table_registry WHERE name != \'namespace_store\''),[{name:'jobs',version:2}]);await store.registerTable(v2);}finally{await store.close();}
}));
