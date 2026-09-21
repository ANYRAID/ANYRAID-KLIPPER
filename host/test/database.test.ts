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
 try{await store.insert('ui','a',5);await store.insert('ui','a.x.y',{n:1});await store.insert('ui',['literal.dot','__proto__'],{safe:true});assert.deepEqual(await store.get('ui','a'),{x:{y:{n:1}}});await store.insert('ui','a',null);assert.deepEqual(await store.get('ui','a.x.y'),{n:1});await assert.rejects(store.insert('ui','a.x.y.n.child',2),/not an object/);assert.equal(await store.get('ui','a.x.y.n'),1);assert.deepEqual(await store.delete('ui','a.x.y'),{n:1});assert.deepEqual(await store.get('ui','a'),{x:{}});await store.close();store=await DatabaseStore.open({path});assert.deepEqual(await store.get('ui',['literal.dot','__proto__']),{safe:true});assert.deepEqual(await store.delete('ui','a'),{x:{}});assert.deepEqual(await store.delete('ui',['literal.dot','__proto__']),{safe:true});assert.deepEqual(await store.get('ui'),{});}finally{await store.close();}
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
test('database updates and literal-key batches match pinned Python including null and sequential rename collisions',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');
 const operations:Json[][]=[['insertBatch','ui',{a:{x:1,sub:{old:1}},b:2,'literal.dot':null}],['update','ui','a',{y:2}],['update','ui','a.sub',{added:2}],['get','ui','a'],['update','ui','a.x',null],['update','ui','b',null],['getBatch','ui',['a','b','literal.dot','missing','a']],['moveBatch','ui',['a','b'],['b','a']],['getBatch','ui',['a','b']],['insertBatch','ui',{c:3,d:4}],['moveBatch','ui',['c','d'],['c.new']],['getBatch','ui',['c','d','c.new']],['deleteBatch','ui',['a','a','missing','literal.dot']],['getBatch','ui',[]],['getBatch','ui',['a','literal.dot','c.new','d']]];
 const expected=spawnSync('/usr/bin/python3',['-c',databaseOracle()],{input:JSON.stringify({operations}),encoding:'utf8'});assert.equal(expected.status,0,expected.stderr);
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite')}),actual:Json[]=[];
 try{for(const [method,namespace,...args] of operations){const methods={insertBatch:()=>store.insertBatch(namespace as string,args[0] as Record<string,Json>),update:()=>store.update(namespace as string,args[0] as string,args[1]),get:()=>store.get(namespace as string,args[0] as string),getBatch:()=>store.getBatch(namespace as string,args[0] as string[]),moveBatch:()=>store.moveBatch(namespace as string,args[0] as string[],args[1] as string[]),deleteBatch:()=>store.deleteBatch(namespace as string,args[0] as string[])};actual.push({value:await methods[method as keyof typeof methods]()});}assert.deepEqual(actual,JSON.parse(expected.stdout));}finally{await store.close();}
}));
test('invalid updates and oversized batch entries roll back all prior modifications',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxRecordBytes:128,maxReplyBytes:100});
 try{
  await store.insertBatch('ui',{a:{x:1},b:'old'});await assert.rejects(store.update('ui','a.x.child',2));assert.deepEqual(await store.get('ui','a'),{x:1});await assert.rejects(store.update('ui','missing',{x:1}),e=>e instanceof ApiError&&e.status===404);
  await assert.rejects(store.insertBatch('ui',{b:'new',c:'x'.repeat(200)}),e=>e instanceof ApiError&&e.status===413);assert.equal(await store.get('ui','b'),'old');await assert.rejects(store.get('ui','c'),e=>e instanceof ApiError&&e.status===404);
  await store.insertBatch('ui',{one:'x'.repeat(60),two:'y'.repeat(60)});await assert.rejects(store.deleteBatch('ui',['one','two']),e=>e instanceof ApiError&&e.status===413);assert.equal(await store.get('ui','one'),'x'.repeat(60));assert.equal(await store.get('ui','two'),'y'.repeat(60));
  const mutable={first:{n:1},second:null};const write=store.insertBatch('owned',mutable);mutable.first.n=999;await write;assert.deepEqual(await store.getBatch('owned',['first','second']),{first:{n:1},second:null});
  assert.throws(()=>store.moveBatch('ui',['b'],['']),/batch keys/);assert.equal(await store.get('ui','b'),'old');
 }finally{await store.close();}
}));
test('multi-statement batches roll back earlier SQL chunks and return one consistent acknowledged state',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxRecordBytes:128});
 try{const records=Object.fromEntries(Array.from({length:130},(_,i)=>['key'+i,i]));await store.insertBatch('ui',records);assert.deepEqual(await store.getBatch('ui',Object.keys(records)),records);
  const invalid:Record<string,Json>={...records,key129:'x'.repeat(200)};for(let i=0;i<129;i++)invalid['key'+i]=-i-1;await assert.rejects(store.insertBatch('ui',invalid),e=>e instanceof ApiError&&e.status===413);assert.deepEqual(await store.getBatch('ui',Object.keys(records)),records);
  await store.moveBatch('ui',['key0','key1'],['__proto__','hasOwnProperty']);assert.deepEqual(await store.getBatch('ui',['__proto__','hasOwnProperty']),Object.fromEntries([['__proto__',0],['hasOwnProperty',1]]));
 }finally{await store.close();}
}));
test('online backup includes committed WAL records and excludes writes queued behind it',()=>directory(async dir=>{
 const {readFile,readdir}=await import('node:fs/promises'),path=join(dir,'active.sqlite'),backups=join(dir,'backups'),store=await DatabaseStore.open({path,backupDirectory:backups});
 try{await store.insert('ui','value','before');const backing=store.backup('snapshot.db'),writing=store.insert('ui','value','after');assert.deepEqual(await backing,{backup_path:join(backups,'snapshot.db')});await writing;
  const copy=await DatabaseStore.open({path:join(backups,'snapshot.db')});try{assert.equal(await copy.get('ui','value'),'before');}finally{await copy.close();}
  const first=await readFile(join(backups,'snapshot.db'));await store.backup('snapshot.db');assert.notDeepEqual(await readFile(join(backups,'snapshot.db')),first);assert.deepEqual(await readdir(backups),['snapshot.db']);assert.deepEqual(await store.list(),{namespaces:['ui'],backups:['snapshot.db']});
  const deleting=store.deleteBackup('snapshot.db'),closing=store.close();assert.deepEqual(await deleting,{backup_path:join(backups,'snapshot.db')});await closing;assert.deepEqual(await readdir(backups),[]);
 }finally{await store.close();}
}));
test('backup paths reject traversal, symlinks and the active database; failure preserves existing backups',()=>directory(async dir=>{
 const {writeFile,readFile}=await import('node:fs/promises'),path=join(dir,'active.sqlite'),store=await DatabaseStore.open({path,backupDirectory:dir});try{
  await writeFile(join(dir,'old.db'),'keep');await symlink('old.db',join(dir,'link.db'));
  for(const name of ['../escape','sub/file','..','', '\ud800'])assert.throws(()=>store.backup(name));
  await assert.rejects(store.backup('active.sqlite'),/active database/);await assert.rejects(store.deleteBackup('active.sqlite'),/active database/);await assert.rejects(store.backup('link.db'),/regular file/);assert.equal(await readFile(join(dir,'old.db'),'utf8'),'keep');await assert.rejects(store.deleteBackup('missing.db'),e=>e instanceof ApiError&&e.status===404);
 }finally{await store.close();}
}));
test('compaction preserves records and leaves prepared statements usable',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{
  await store.insertBatch('ui',Object.fromEntries(Array.from({length:200},(_,i)=>['key'+i,'x'.repeat(2048)])));await store.deleteBatch('ui',Array.from({length:190},(_,i)=>'key'+i));await store.close();store=await DatabaseStore.open({path});
  const sizes=await store.compact() as {previous_size:number;new_size:number};assert.ok(sizes.new_size<sizes.previous_size);assert.equal(await store.get('ui','key199'),'x'.repeat(2048));await store.insert('ui','new',1);assert.equal(await store.get('ui','new'),1);
 }finally{await store.close();}
}));
test('failed backup production preserves the previous published file and removes its staging directory',()=>directory(async dir=>{
 const {writeFile,readFile,readdir}=await import('node:fs/promises'),{createDatabaseBackup}=await import('../src/moonraker/database-backup-files.ts');const source=join(dir,'source.sqlite'),destination=join(dir,'saved.db');await writeFile(source,'source');await writeFile(destination,'old backup');
 const failed={async backup(path:string){await writeFile(path,'partial');throw new Error('injected backup failure');}} as unknown as import('../src/moonraker/database-engine.ts').DatabaseEngine;
 await assert.rejects(createDatabaseBackup(failed,dir,'saved.db',source),/injected/);assert.equal(await readFile(destination,'utf8'),'old backup');assert.deepEqual((await readdir(dir)).sort(),['saved.db','source.sqlite']);
}));
test('restore replaces the live SQLite database and fences queued stale writes until reopen',()=>directory(async dir=>{
 const path=join(dir,'active.sqlite'),store=await DatabaseStore.open({path,backupDirectory:join(dir,'backups')});
 try{await store.insert('ui','generation',1);await store.backup('saved.db');await store.insert('ui','generation',2);const restore=store.restore('saved.db'),late=store.insert('ui','late',true);const rejected=assert.rejects(late,e=>e instanceof ApiError&&e.status===503);const info=await restore as {restored_tables:string[];restored_namespaces:string[]};await rejected;assert.ok(info.restored_tables.includes('namespace_store'));assert.deepEqual(info.restored_namespaces,['ui']);assert.equal(store.status.restoreState,'restored');await assert.rejects(store.get('ui','generation'),e=>e instanceof ApiError&&e.status===503);}finally{await store.close();}
 const reopened=await DatabaseStore.open({path});try{assert.equal(await reopened.get('ui','generation'),1);await assert.rejects(reopened.get('ui','late'),e=>e instanceof ApiError&&e.status===404);}finally{await reopened.close();}
}));
test('restore preflight rejects malformed, oversized or missing snapshots without freezing the active store',()=>directory(async dir=>{
 const {writeFile}=await import('node:fs/promises'),path=join(dir,'active.sqlite'),store=await DatabaseStore.open({path,backupDirectory:dir,maxDatabaseBytes:65536});
 try{await store.insert('ui','value','keep');await writeFile(join(dir,'invalid.db'),'not a database');await assert.rejects(store.restore('invalid.db'),e=>e instanceof ApiError&&e.status===422);assert.equal(store.status.restoreState,'ready');
  await assert.rejects(store.restore('missing.db'),e=>e instanceof ApiError&&e.status===404);
  const bad=new DatabaseSync(join(dir,'wrong.db'));bad.exec('CREATE TABLE namespace_store (x TEXT)');bad.close();await assert.rejects(store.restore('wrong.db'),e=>e instanceof ApiError&&e.status===422);
  const large=new DatabaseSync(join(dir,'large.db'));large.exec('CREATE TABLE data (value BLOB); INSERT INTO data VALUES (zeroblob(131072))');large.close();await assert.rejects(store.restore('large.db'),e=>e instanceof ApiError&&e.status===413);assert.equal(store.status.restoreState,'ready');assert.equal(await store.get('ui','value'),'keep');await store.insert('ui','still_writable',true);
 }finally{await store.close();}
}));
test('restore copies non-namespace tables as well as namespace data',()=>directory(async dir=>{
 const path=join(dir,'active.sqlite'),store=await DatabaseStore.open({path,backupDirectory:dir});
 try{await store.insert('ui','x',1);const sql=new DatabaseSync(path);sql.exec('CREATE TABLE extension_data (id INTEGER PRIMARY KEY, content BLOB); INSERT INTO extension_data VALUES (1,x\'0001ff\')');sql.close();await store.backup('extension.db');
  const changed=new DatabaseSync(path);changed.exec('DROP TABLE extension_data');changed.close();const info=await store.restore('extension.db') as {restored_tables:string[]};assert.ok(info.restored_tables.includes('extension_data'));
 }finally{await store.close();}
 const restored=new DatabaseSync(path);try{assert.deepEqual(Buffer.from(restored.prepare('SELECT content FROM extension_data WHERE id=1').get()!.content as Uint8Array),Buffer.from([0,1,255]));assert.equal(restored.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');}finally{restored.close();}
}));
test('a client cancellation after restore admission still requests restart after the copy completes',()=>directory(async dir=>{
 const {EndpointRegistry}=await import('../src/moonraker/endpoints.ts'),{JsonRpcDispatcher}=await import('../src/moonraker/rpc.ts'),{ResponseCompletion}=await import('../src/moonraker/response-completion.ts'),{registerDatabaseMaintenance}=await import('../src/moonraker/database-maintenance.ts');
 const store=await DatabaseStore.open({path:join(dir,'active.sqlite'),backupDirectory:dir}),controller=new AbortController(),completion=new ResponseCompletion(controller.signal),registry=new EndpointRegistry(new JsonRpcDispatcher());let restarts=0;const release=registerDatabaseMaintenance(registry,store,()=>{},()=>{restarts++;});
 try{await store.insert('ui','x',1);await store.backup('saved.db');await store.insert('ui','x',2);const restore=store.restore.bind(store);store.restore=filename=>{const pending=restore(filename);controller.abort(new Error('client disconnected'));return pending;};
  await assert.rejects(registry.invoke('/server/database/restore','POST',{filename:'saved.db'},{transport:'http',signal:controller.signal,authorize(){},afterResponse:callback=>completion.add(callback)}),/client disconnected/);assert.equal(store.status.restoreState,'restored');assert.equal(restarts,1);completion.complete(false);assert.equal(restarts,1);
 }finally{release();await store.close();}
}));

test('empty namespace lifetime matches pinned provider methods and API delete remains distinct',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');
 const operations:Json[][]=[['get','empty'],['registerNamespace','empty'],['get','empty'],['namespaceLength','empty'],['insert','empty','x',1],['dropEmptyNamespace','empty'],['get','empty'],['delete','empty','x'],['get','empty'],['dropEmptyNamespace','empty'],['get','empty'],['insertBatch','batch',{}],['get','batch'],['insert','null','x',null],['get','null'],['clearNamespace','absent'],['get','absent'],['insertBatch','batch',{a:1,b:2}],['namespaceLength','batch'],['clearNamespace','batch'],['get','batch'],['namespaceLength','batch'],['dropEmptyNamespace','batch'],['get','batch']];
 const expected=spawnSync('/usr/bin/python3',['-c',databaseOracle()],{input:JSON.stringify({operations}),encoding:'utf8'});assert.equal(expected.status,0,expected.stderr);
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite')}),actual:Json[]=[];
 try{for(const [method,namespace,...args] of operations){try{let result:Json;switch(method){case 'registerNamespace':result=await store.registerNamespace(namespace as string);break;case 'namespaceLength':result=await store.namespaceLength(namespace as string);break;case 'clearNamespace':result=await store.clearNamespace(namespace as string);break;case 'dropEmptyNamespace':result=await store.dropEmptyNamespace(namespace as string);break;case 'insert':result=await store.insert(namespace as string,args[0] as string,args[1]);break;case 'insertBatch':result=await store.insertBatch(namespace as string,args[0] as Record<string,Json>);break;case 'delete':result=await store.delete(namespace as string,args[0] as string);break;default:result=await store.get(namespace as string);}actual.push({value:result});}catch(error){assert.ok(error instanceof ApiError);actual.push({error:error.status});}}assert.deepEqual(actual,JSON.parse(expected.stdout));
  await store.insert('api','last',1);await store.api('DELETE','api','last');await assert.rejects(store.get('api'),e=>e instanceof ApiError&&e.status===404);
 }finally{await store.close();}
}));
test('virtual namespaces disappear on reopen; committed data reconstructs namespace membership',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{await store.registerNamespace('virtual');await store.insertBatch('batch',{});await store.insert('data','value',3);assert.deepEqual(await store.list(),{namespaces:['batch','data','virtual'],backups:[]});await store.close();store=await DatabaseStore.open({path});assert.deepEqual(await store.list(),{namespaces:['data'],backups:[]});assert.deepEqual(await store.get('data'),{value:3});await assert.rejects(store.get('virtual'));}finally{await store.close();}
}));
test('namespace budget rejects new names before writes, failed writes leave no phantom namespace',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxReplyBytes:32,maxRecordBytes:16});try{await assert.rejects(store.insert('failed','x','z'.repeat(32)),e=>e instanceof ApiError&&e.status===413);await assert.rejects(store.get('failed'),e=>e instanceof ApiError&&e.status===404);await store.registerNamespace('a'.repeat(24));await assert.rejects(store.insert('too-long','x',1),e=>e instanceof ApiError&&e.status===413);await assert.rejects(store.get('too-long','x'),e=>e instanceof ApiError&&e.status===404);await store.dropEmptyNamespace('a'.repeat(24));await store.insert('too-long','x',1);assert.equal(await store.get('too-long','x'),1);}finally{await store.close();}
}));

test('atomic namespace replacement matches pinned Python for structured records and preserves literal keys',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');
 const operations:Json[][]=[['registerNamespace','ui'],['insertBatch','ui',{old:{x:1},keep:{old:true}}],['syncNamespace','ui',{keep:{new:true},'literal.dot':[1,2.675,null]}],['get','ui'],['namespaceLength','ui'],['syncNamespace','ui',{}],['get','ui']];
 const expected=spawnSync('/usr/bin/python3',['-c',databaseOracle()],{input:JSON.stringify({operations}),encoding:'utf8'});assert.equal(expected.status,0,expected.stderr);const store=await DatabaseStore.open({path:join(dir,'db.sqlite')}),actual:Json[]=[];
 try{for(const [method,namespace,value] of operations){let result:Json;switch(method){case 'registerNamespace':result=await store.registerNamespace(namespace as string);break;case 'insertBatch':result=await store.insertBatch(namespace as string,value as Record<string,Json>);break;case 'syncNamespace':result=await store.syncNamespace(namespace as string,value as Record<string,Json>);break;case 'namespaceLength':result=await store.namespaceLength(namespace as string);break;default:result=await store.get(namespace as string);}actual.push({value:result});}assert.deepEqual(actual,JSON.parse(expected.stdout));}finally{await store.close();}
}));
test('namespace sync fixes upstream scalar encoding and retains precise values across reopening',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');const result=spawnSync('/usr/bin/python3',['-c',databaseOracle()],{input:JSON.stringify({operations:[['registerNamespace','ui'],['syncNamespace','ui',{scalar:1}],['get','ui']]}),encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),[{value:null},{value:null},{error:500}]);
 const path=join(dir,'db.sqlite'),values={zero:-0,large:1e20,tiny:1e-200,safe:Number.MAX_SAFE_INTEGER,temperature:2.675,flag:true,empty:null,text:'中文',nested:{zero:-0,large:1e20}};let store=await DatabaseStore.open({path});try{await store.registerNamespace('ui');await store.syncNamespace('ui',values);assert.deepEqual(await store.get('ui'),values);await store.close();store=await DatabaseStore.open({path});assert.deepEqual(await store.get('ui'),values);}finally{await store.close();}
}));
test('late replacement failure rolls back deletion and every inserted chunk; queue order and input ownership remain intact',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxRecordBytes:128});try{
  await assert.rejects(store.syncNamespace('missing',{x:1}),e=>e instanceof ApiError&&e.status===404);await store.insertBatch('ui',{old:1,keep:{v:'old'}});
  const values:Record<string,Json>=Object.fromEntries(Array.from({length:130},(_,i)=>['k'+i,i]));values.k129='x'.repeat(256);await assert.rejects(store.syncNamespace('ui',values),e=>e instanceof ApiError&&e.status===413);assert.deepEqual(await store.get('ui'),{old:1,keep:{v:'old'}});
  const next={new:{version:2}},replacing=store.syncNamespace('ui',next);next.new.version=3;const reading=store.get('ui');await replacing;assert.deepEqual(await reading,{new:{version:2}});await store.syncNamespace('ui',{});assert.deepEqual(await store.get('ui'),{});
 }finally{await store.close();}
}));

test('record codec fast paths retain floating-point distinctions, special field names and UTF-8 failure isolation',()=>{
 const examples:Json[]=[{a:1,b:[2.675,1e-200],c:'中文'},{a:{b:[-0,1e20,1e21,1e100]}},JSON.parse('{"__proto__":{"safe":true},"constructor":1,"toString":2}')];
 for(const value of examples)assert.deepEqual(decodeDatabaseRecord(encodeDatabaseRecord(value)),value);
 for(let i=0;i<100;i++){assert.throws(()=>decodeDatabaseRecord(Buffer.from([115,0xe4,0xb8])),e=>e instanceof ApiError&&e.status===422);assert.equal(decodeDatabaseRecord(encodeDatabaseRecord('中文🙂')),'中文🙂');assert.throws(()=>decodeDatabaseRecord(Buffer.from([123,34,0xff])),e=>e instanceof ApiError&&e.status===422);assert.deepEqual(decodeDatabaseRecord(encodeDatabaseRecord({ok:true})),{ok:true});}
 const cycle:Record<string,unknown>={};cycle.self=cycle;assert.throws(()=>encodeDatabaseRecord(cycle as Json));assert.throws(()=>encodeDatabaseRecord({a:Infinity}));
});
test('fast result construction never treats special keys as prototype operations',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite')});try{const data=JSON.parse('{"__proto__":{"safe":true},"constructor":1,"toString":2,"hasOwnProperty":3}');await store.insertBatch('ui',data);const result=await store.get('ui');assert.deepEqual(result,data);assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(Object.hasOwn(result as object,'__proto__'),true);assert.deepEqual(await store.getBatch('ui',Object.keys(data)),data);await store.update('ui','__proto__',{added:1});assert.deepEqual(await store.get('ui','__proto__'),{safe:true,added:1});assert.equal(({} as Record<string,unknown>).safe,undefined);}finally{await store.close();}
}));

test('local namespace registration matches pinned component policies and rejects duplicate owners',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');const operations:[string,string,boolean?][]=[['register','\u{10000}',false],['register','\ue000',false],['register','ui',false],['register','hidden',true],['unregister','ui'],['register','ui',true],['unregister','missing'],['unregister','hidden']];
 const base=databaseOracle().slice(0,databaseOracle().indexOf('def main():')),program=base+String.raw`
component=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='MoonrakerDatabase')
body=[n for n in component.body if isinstance(n,ast.FunctionDef) and n.name in {'register_local_namespace','unregister_local_namespace'}]
exec('from __future__ import annotations\nclass Component:\n'+textwrap.indent(ast.unparse(ast.Module(body=body,type_ignores=[])),'    '))
NamespaceWrapper=lambda *args: None
provider,conn=create();owner=Component();owner.server=Server();owner.registered_namespaces={'database','moonraker'};owner.protected_namespaces={'moonraker'};owner.forbidden_namespaces={'database'};owner.db_provider=provider
owner.insert_item=lambda ns,key,value: provider.insert_item(conn,ns,key,value)
results=[]
for op in json.load(sys.stdin):
 if op[0]=='register': owner.register_local_namespace(op[1],op[2])
 else: owner.unregister_local_namespace(op[1])
 results.append({'visible':sorted(provider._namespaces-owner.forbidden_namespaces),'protected':provider.get_item(conn,'database','protected_namespaces',None),'forbidden':provider.get_item(conn,'database','forbidden_namespaces',None)})
print(json.dumps(results));conn.close()
`;
 const expected=spawnSync('/usr/bin/python3',['-c',program],{input:JSON.stringify(operations),encoding:'utf8'});assert.equal(expected.status,0,expected.stderr);
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite')}),actual:Json[]=[];try{for(const [op,namespace,forbidden] of operations){if(op==='register')await store.registerLocalNamespace(namespace,{forbidden});else await store.unregisterLocalNamespace(namespace);const fallback=async(key:string)=>{try{return await store.get('database',key);}catch(error){if(error instanceof ApiError&&error.status===404)return null;throw error;}};actual.push({visible:(await store.list() as {namespaces:Json}).namespaces,protected:await fallback('protected_namespaces'),forbidden:await fallback('forbidden_namespaces')});}assert.deepEqual(actual,JSON.parse(expected.stdout));await assert.rejects(store.registerLocalNamespace('ui'),e=>e instanceof ApiError&&e.status===409);for(const namespace of ['database','moonraker'])await assert.rejects(store.unregisterLocalNamespace(namespace),e=>e instanceof ApiError&&e.status===403);}finally{await store.close();}
}));
test('namespace wrappers preserve literal versus parsed keys, internal writes, public permissions and reopened policies',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite');let store=await DatabaseStore.open({path});try{const ui=await store.registerLocalNamespace('ui');await ui.insert('a.b',{x:1});assert.deepEqual(await ui.get('a.b'),{x:1});assert.equal(await ui.get('missing'),null);assert.equal(await ui.get('missing','fallback'),'fallback');await ui.updateChild('a.b',{y:2});assert.deepEqual(await ui.get('a.b'),{x:1,y:2});assert.deepEqual(await store.api('GET','ui',['a.b']),{namespace:'ui',key:['a.b'],value:{x:1,y:2}});await assert.rejects(store.api('POST','ui','other',2),e=>e instanceof ApiError&&e.status===403);
 const parsed=await store.wrapNamespace('ui');await parsed.insert('nested.value',3);assert.equal(await parsed.get(['nested','value']),3);assert.equal(await ui.length(),2);await ui.update({z:4});await ui.moveBatch(['z'],['z.new']);assert.deepEqual(await ui.getBatch(['z.new']),{'z.new':4});assert.deepEqual(await ui.deleteBatch(['z.new']),{'z.new':4});
 const hidden=await store.registerLocalNamespace('hidden',{forbidden:true});await hidden.insert('secret',1);await assert.rejects(store.api('GET','hidden','secret'),e=>e instanceof ApiError&&e.status===403);await store.close();store=await DatabaseStore.open({path});await assert.rejects(store.api('POST','ui','x',1),e=>e instanceof ApiError&&e.status===403);await assert.rejects(store.api('GET','hidden','secret'),e=>e instanceof ApiError&&e.status===403);await store.registerLocalNamespace('ui');await store.unregisterLocalNamespace('ui');await store.api('POST','ui','x',1);await assert.rejects(store.wrapNamespace('absent'),e=>e instanceof ApiError&&e.status===404);
 }finally{await store.close();}
}));
test('failed registration leaves no owner and failed multi-policy removal rolls back both updates',()=>directory(async dir=>{
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxRecordBytes:32});try{
  const long='x'.repeat(30);await assert.rejects(store.registerLocalNamespace(long),e=>e instanceof ApiError&&e.status===413);await assert.rejects(store.wrapNamespace(long),e=>e instanceof ApiError&&e.status===404);await assert.rejects(store.registerLocalNamespace(long),e=>e instanceof ApiError&&e.status===413);
  await store.registerLocalNamespace('target',{forbidden:true});await store.insert('database','forbidden_namespaces',['target']);await store.insert('database','protected_namespaces',['target','b'.repeat(17)]);
  await assert.rejects(store.unregisterLocalNamespace('target'),e=>e instanceof ApiError&&e.status===413);assert.deepEqual(await store.get('database','forbidden_namespaces'),['target']);assert.deepEqual(await store.get('database','protected_namespaces'),['target','b'.repeat(17)]);await assert.rejects(store.registerLocalNamespace('target'),e=>e instanceof ApiError&&e.status===409);
  await store.insert('database','protected_namespaces',['target']);await store.unregisterLocalNamespace('target');await store.registerLocalNamespace('target');
 }finally{await store.close();}
}));

test('namespace keys values items and nested existence match pinned provider queries',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');
 const operations:Json[][]=[['namespaceKeys','missing'],['namespaceValues','missing'],['namespaceItems','missing'],['namespaceContains','missing','x'],['insertBatch','ui',{z:null,a:{nested:{zero:0,flag:false}},'literal.dot':[1,2.675],constructor:'value'}],['namespaceKeys','ui'],['namespaceValues','ui'],['namespaceItems','ui'],['namespaceContains','ui','a.nested.zero'],['namespaceContains','ui','a.nested.flag'],['namespaceContains','ui','a.absent'],['namespaceContains','ui','z'],['namespaceContains','ui','z.child']];
 const expected=spawnSync('/usr/bin/python3',['-c',databaseOracle()],{input:JSON.stringify({operations}),encoding:'utf8'});assert.equal(expected.status,0,expected.stderr);const store=await DatabaseStore.open({path:join(dir,'db.sqlite')}),actual:Json[]=[];try{for(const [method,namespace,key] of operations){let value:Json;switch(method){case 'insertBatch':value=await store.insertBatch(namespace as string,key as Record<string,Json>);break;case 'namespaceKeys':value=await store.namespaceKeys(namespace as string);break;case 'namespaceValues':value=await store.namespaceValues(namespace as string);break;case 'namespaceItems':value=await store.namespaceItems(namespace as string);break;default:value=await store.namespaceContains(namespace as string,key as string);}actual.push({value});}assert.deepEqual(actual,JSON.parse(expected.stdout));}finally{await store.close();}
}));
test('literal-root existence fixes pinned list binding bug and wrapper pop respects missing defaults only',()=>directory(async dir=>{
 const {spawnSync}=await import('node:child_process'),{databaseOracle}=await import('./helpers/database-oracle.ts');const expected=spawnSync('/usr/bin/python3',['-c',databaseOracle()],{input:JSON.stringify({operations:[['insertBatch','ui',{'a.b':null}],['namespaceContains','ui',['a.b']]]}),encoding:'utf8'});assert.equal(expected.status,0,expected.stderr);assert.deepEqual(JSON.parse(expected.stdout),[{value:null},{value:false}]);
 const store=await DatabaseStore.open({path:join(dir,'db.sqlite'),maxReplyBytes:128,maxRecordBytes:1024});try{const owner=await store.registerLocalNamespace('ui');await owner.update({'a.b':null});assert.equal(await owner.contains('a.b'),true);assert.equal(await store.namespaceContains('ui','a.b'),false);assert.deepEqual(await owner.keys(),['a.b']);assert.deepEqual(await owner.values(),[null]);assert.deepEqual(await owner.items(),[['a.b',null]]);assert.equal(await owner.pop('a.b','fallback'),null);assert.equal(await owner.contains('a.b'),false);assert.equal(await owner.pop('missing','fallback'),'fallback');await assert.rejects(owner.pop('missing'),e=>e instanceof ApiError&&e.status===404);
  await owner.insert('large','x'.repeat(256));await assert.rejects(owner.pop('large','fallback'),e=>e instanceof ApiError&&e.status===413);assert.equal(await owner.contains('large'),true);await assert.rejects(owner.values(),e=>e instanceof ApiError&&e.status===413);await assert.rejects(owner.items(),e=>e instanceof ApiError&&e.status===413);assert.deepEqual(await owner.keys(),['large']);
 }finally{await store.close();}
}));
test('enumeration retains precise floating records and existence never hides corrupt nested data',()=>directory(async dir=>{
 const path=join(dir,'db.sqlite'),store=await DatabaseStore.open({path});try{await store.insertBatch('ui',{zero:-0,large:1e20,tiny:1e-200,nested:{x:1}});assert.deepEqual(await store.namespaceItems('ui'),[['large',1e20],['nested',{x:1}],['tiny',1e-200],['zero',-0]]);
  const raw=new DatabaseSync(path);try{raw.prepare('UPDATE namespace_store SET value=? WHERE namespace=? AND key=?').run(Buffer.from('invalid'),'ui','nested');}finally{raw.close();}assert.equal(await store.namespaceContains('ui','nested'),true);await assert.rejects(store.namespaceContains('ui','nested.x'),e=>e instanceof ApiError&&e.status===422);await assert.rejects(store.namespaceValues('ui'),e=>e instanceof ApiError&&e.status===422);assert.deepEqual(await store.namespaceKeys('ui'),['large','nested','tiny','zero']);
 }finally{await store.close();}
}));
