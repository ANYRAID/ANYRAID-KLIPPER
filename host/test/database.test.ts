import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {encodeDatabaseRecord,decodeDatabaseRecord} from '../src/moonraker/database-record.ts';
import {ApiError,type Json} from '../src/moonraker/rpc.ts';
async function directory(run:(path:string)=>Promise<void>){const path=await mkdtemp(join(tmpdir(),'database-store-'));try{await run(path);}finally{await rm(path,{recursive:true,force:true});}}
test('database record format preserves scalar types, exact floats, nested large floats and rejects unsafe stored integers',()=>{
 const values:Json[]=[null,true,false,'中文🙂',0,-0,1,-123,Number.MAX_SAFE_INTEGER,1.005,1e20,1e-100,{x:1e20,z:-0,a:[true,null,'x']}];for(const value of values)assert.deepEqual(decodeDatabaseRecord(encodeDatabaseRecord(value)),value);
 const unsafe=Buffer.alloc(9);unsafe[0]=113;unsafe.writeBigInt64LE(9007199254740993n,1);assert.throws(()=>decodeDatabaseRecord(unsafe),/safe JSON/);
 for(const value of [Buffer.from([]),Buffer.from('x'),Buffer.from([100]),Buffer.from([115,255]),Buffer.from('{"x":9007199254740993}')])assert.throws(()=>decodeDatabaseRecord(value));assert.throws(()=>encodeDatabaseRecord('\ud800'),/Unicode/);
});
test('worker database persists nested changes, no-op top-level null and atomic failure across reopen',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});
 try{await store.insert('ui','a',5);await store.insert('ui','a.x.y',{n:1});await store.insert('ui',['literal.dot','__proto__'],{safe:true});assert.deepEqual(await store.get('ui','a'),{x:{y:{n:1}}});await store.insert('ui','a',null);assert.deepEqual(await store.get('ui','a.x.y'),{n:1});await assert.rejects(store.insert('ui','a.x.y.n.child',2),/not an object/);assert.equal(await store.get('ui','a.x.y.n'),1);assert.deepEqual(await store.delete('ui','a.x.y'),{n:1});assert.deepEqual(await store.get('ui','a'),{x:{}});await store.close();store=await DatabaseStore.open({path});assert.deepEqual(await store.get('ui',['literal.dot','__proto__']),{safe:true});assert.deepEqual(await store.delete('ui','a'),{x:{}});assert.deepEqual(await store.delete('ui',['literal.dot','__proto__']),{safe:true});await assert.rejects(store.get('ui'),e=>e instanceof ApiError&&e.status===404);}finally{await store.close();}
}));
test('worker API respects persisted protected and forbidden namespaces and bounded admission',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxPending:1,maxRecordBytes:64});try{
  await store.insert('moonraker','version','test');await store.insert('database','forbidden_namespaces',['secret']);await store.insert('secret','token','private');
  assert.deepEqual(await store.list(),{namespaces:['moonraker'],backups:[]});assert.deepEqual(await store.api('GET','moonraker','version'),{namespace:'moonraker',key:'version',value:'test'});
  await assert.rejects(store.api('POST','moonraker','version','change'),e=>e instanceof ApiError&&e.status===403);await assert.rejects(store.api('GET','database',null),e=>e instanceof ApiError&&e.status===403);await assert.rejects(store.api('GET','secret','token'),e=>e instanceof ApiError&&e.status===403);
  const first=store.insert('ui','x',1),second=store.insert('ui','y',2);await assert.rejects(second,e=>e instanceof ApiError&&e.status===429);await first;
  await assert.rejects(store.insert('ui','x','a'.repeat(100)),e=>e instanceof ApiError&&e.status===413);assert.equal(await store.get('ui','x'),1);
 }finally{await store.close();}await assert.rejects(store.get('ui','x'),/closed/);
}));
test('database rejects symlink files and malformed pre-existing schemas',()=>directory(async dir=>{
 const file=join(dir,'bad.sqlite'),db=new DatabaseSync(file);db.exec('CREATE TABLE namespace_store (x TEXT)');db.close();await assert.rejects(DatabaseStore.open({path:file}),/schema/);
 await symlink(file,join(dir,'link.sqlite'));await assert.rejects(DatabaseStore.open({path:join(dir,'link.sqlite')}),/regular file/);
}));
test('namespace transactions and persisted record interoperability match pinned Python methods',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');
 const operations:Json[][]=[['get','ui','missing'],['insert','ui','root',5],['insert','ui','root.a.b',1],['insert','ui',['literal.dot'],{x:[1,'中文',null],temperature:2.675}],['get','ui'],['insert','ui','root.a.c',null],['get','ui','root.a'],['insert','ui','root',null],['get','ui','root'],['delete','ui','root.a.b'],['delete','ui','root.a.c'],['get','ui','root'],['delete','ui','root'],['get','ui','root']];
 const pyPath=join(dir,'python.sqlite'),result=spawnSync('/usr/bin/python3',['-c',databaseOracle()],{input:JSON.stringify({path:pyPath,operations}),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const owner=await DatabaseStore.open({path:join(dir,'node.sqlite')}),actual:Json[]=[];
 try{for(const [method,namespace,key,value] of operations){try{const result=method==='insert'?await owner.insert(namespace as string,key as string,value):method==='delete'?await owner.delete(namespace as string,key as string):await owner.get(namespace as string,key as string|undefined);actual.push({value:result});}catch(error){assert.ok(error instanceof ApiError);actual.push({error:error.status});}}assert.deepEqual(actual,JSON.parse(result.stdout));}finally{await owner.close();}
 const imported=await DatabaseStore.open({path:pyPath});try{assert.deepEqual(await imported.get('ui',['literal.dot']),{x:[1,'中文',null],temperature:2.675});await imported.insert('ui','from_node',{ok:true});}finally{await imported.close();}
 const verify=spawnSync('/usr/bin/python3',['-c',databaseOracle().slice(0,databaseOracle().indexOf('def main():'))+"\nconn=sqlite3.connect(sys.argv[1],detect_types=sqlite3.PARSE_DECLTYPES)\nprint(json.dumps(conn.execute(\"SELECT value FROM namespace_store WHERE key='from_node'\").fetchone()[0]))",pyPath],{encoding:'utf8'});assert.equal(verify.status,0,verify.stderr);assert.deepEqual(JSON.parse(verify.stdout),{ok:true});
}));
test('configured database REST and RPC authenticate and transfer durable owner lifetime',()=>directory(async dir=>{
 const {writeFile}=await import('node:fs/promises'),{ConfiguredMoonraker}=await import('../src/moonraker/configured-server.ts');const file=join(dir,'moonraker.conf');await writeFile(file,'[server]\nhost=127.0.0.1\nport=0');
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite')}),options={database:store,information:{connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(_m:unknown,_p:unknown,c:any){if(c.request.headers['x-key']!=='test')throw new ApiError(401,'Denied');}},server=await ConfiguredMoonraker.load(file,options);
 try{
  await assert.rejects(ConfiguredMoonraker.load(file,options),/already owned/);const address=await server.start(),url=`http://127.0.0.1:${address.port}`,headers={'x-key':'test','content-type':'application/json'};
  assert.equal((await fetch(url+'/server/database/item',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({namespace:'ui',key:'test',value:9})})).status,401);
  const write=await fetch(url+'/server/database/item',{method:'POST',headers,body:JSON.stringify({namespace:'ui',key:'panel.theme',value:'dark'})});assert.deepEqual(await write.json(),{result:{namespace:'ui',key:'panel.theme',value:'dark'}});
  assert.deepEqual(await(await fetch(url+'/server/database/item?namespace=ui&key=panel.theme',{headers})).json(),{result:{namespace:'ui',key:'panel.theme',value:'dark'}});
  const rpc=await fetch(url+'/server/jsonrpc',{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'server.database.delete_item',params:{namespace:'ui',key:'panel.theme'}})});assert.deepEqual(await rpc.json(),{jsonrpc:'2.0',id:1,result:{namespace:'ui',key:'panel.theme',value:'dark'}});
  await assert.rejects(store.get('ui'),e=>e instanceof ApiError&&e.status===404);
 }finally{await server.close();}assert.equal(store.status.closed,true);assert.equal(server.rpc.has('server.database.get_item'),false);
}));
test('SQLite page exhaustion rolls back a failed write and preserves acknowledged records',()=>directory(async dir=>{
 const path=join(dir,'small.sqlite'),store=await DatabaseStore.open({path,maxDatabaseBytes:65536,maxRecordBytes:8192});let inserted=0;
 try{for(;inserted<100;inserted++){try{await store.insert('ui','key'+inserted,'x'.repeat(2048));}catch(error){assert.ok(error instanceof ApiError);break;}}assert.ok(inserted>0&&inserted<100);assert.equal(await store.get('ui','key0'),'x'.repeat(2048));await assert.rejects(store.get('ui','key'+inserted),e=>e instanceof ApiError&&e.status===404);}finally{await store.close();}
 const db=new DatabaseSync(path);try{assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');assert.equal(Number(db.prepare('SELECT count(*) AS total FROM namespace_store').get()!.total),inserted);}finally{db.close();}
}));
test('API response budget failures occur before writes or deletes commit',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxRecordBytes:4096,maxReplyBytes:80});try{
  await store.insert('ui','large','x'.repeat(100));await assert.rejects(store.api('DELETE','ui','large'),e=>e instanceof ApiError&&e.status===413);
  await assert.rejects(store.api('POST','ui','new','x'.repeat(100)),e=>e instanceof ApiError&&e.status===413);await assert.rejects(store.get('ui','new'),e=>e instanceof ApiError&&e.status===404);
  await store.insert('ui','large.child',1);assert.equal(await store.get('ui','large.child'),1);
 }finally{await store.close();}
}));
test('acknowledged WAL records survive abrupt process termination without a graceful close',()=>directory(async dir=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),path=join(dir,'crash.sqlite');
 const script=`const {DatabaseStore}=await import(${JSON.stringify(new URL('../src/moonraker/database.ts',import.meta.url).href)});const store=await DatabaseStore.open({path:${JSON.stringify(path)}});for(let i=0;i<20;i++)await store.insert('ui','key'+i,{value:i});process.stdout.write('committed');`;
 const child=spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe']});let diagnostics='';child.stderr.on('data',data=>{diagnostics+=data;});const exited=once(child,'exit');
 try{const ready=once(child.stdout,'data');const outcome=await Promise.race([ready.then(([data])=>String(data)),exited.then(()=>{throw new Error('Child exited before committing: '+diagnostics);})]);assert.equal(outcome,'committed');child.kill('SIGKILL');await exited;
  const store=await DatabaseStore.open({path});try{for(let i=0;i<20;i++)assert.deepEqual(await store.get('ui','key'+i),{value:i});}finally{await store.close();}
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exited;}}
}));
test('concurrent server construction cannot take ownership of one database twice',()=>directory(async dir=>{
 const {writeFile}=await import('node:fs/promises'),{ConfiguredMoonraker}=await import('../src/moonraker/configured-server.ts');const file=join(dir,'main.conf');await writeFile(file,'[server]\nhost=127.0.0.1\nport=0');const database=await DatabaseStore.open({path:join(dir,'db.sqlite')}),options={database,information:{connected:false,state:'disconnected' as const,components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize(){}};
 const result=await Promise.allSettled([ConfiguredMoonraker.load(file,options),ConfiguredMoonraker.load(file,options)]);
 try{assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);}finally{for(const r of result)if(r.status==='fulfilled')await r.value.close();await database.close();}
}));
