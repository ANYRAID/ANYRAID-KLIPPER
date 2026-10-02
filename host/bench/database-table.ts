import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseOracle} from '../test/helpers/database-oracle.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'table-bench-')),samples:number[]=[],delays:number[]=[];
try{
 for(let run=0;run<7;run++){const path=join(dir,`node-${run}.db`);let store=await DatabaseStore.open({path});const loop=monitorEventLoopDelay({resolution:1});loop.enable();try{
  let start=performance.now();for(let i=0;i<50;i++){const name='jobs'+i;await store.registerTable({name,prototype:`${name} (id INTEGER PRIMARY KEY, value REAL)`,version:1,migrations:{'0':[`INSERT INTO ${name} VALUES(1,2.675)`]}});}let elapsed=performance.now()-start;await store.close();store=await DatabaseStore.open({path});
  start=performance.now();for(let i=0;i<50;i++){const name='jobs'+i;await store.registerTable({name,prototype:`${name} (id INTEGER PRIMARY KEY, value REAL, label TEXT DEFAULT 'ready')`,version:2,migrations:{'1':[`ALTER TABLE ${name} ADD COLUMN label TEXT DEFAULT 'ready'`]}});}elapsed+=performance.now()-start;
  const db=new DatabaseSync(path,{readOnly:true});try{for(let i=0;i<50;i++){assert.deepEqual({...db.prepare(`SELECT * FROM jobs${i}`).get()},{id:1,value:2.675,label:'ready'});assert.equal(db.prepare('SELECT version FROM table_registry WHERE name=?').get('jobs'+i)!.version,2);}}finally{db.close();}if(run>=2){samples.push(elapsed);delays.push(loop.max/1e6);}
 }finally{loop.disable();await store.close();}}
 const base=databaseOracle().slice(0,databaseOracle().indexOf('def main():')),program=base+String.raw`
import os
methods=[n for n in provider.body if isinstance(n,ast.FunctionDef) and n.name in {'register_table','_save_registered_table','_lookup_registered_table'}]
exec('from __future__ import annotations\nclass Tables(Provider):\n'+textwrap.indent(ast.unparse(ast.Module(body=methods,type_ignores=[])),'    '))
REGISTRATION_TABLE='table_registry'
def owner(path):
 conn=sqlite3.connect(path);conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL');conn.execute('CREATE TABLE IF NOT EXISTS table_registry (name TEXT PRIMARY KEY, prototype TEXT NOT NULL, version INT)');conn.commit()
 p=Tables();p.server=Server();p.server.add_warning=lambda x:None;p.sync_conn=conn;p._tables={row[0] for row in conn.execute("SELECT name FROM sqlite_schema WHERE type='table'")};p.is_alive=lambda:False;p.get_provider_wapper=lambda:conn
 return p,conn
def definition(name,version):
 prototype=name+" (id INTEGER PRIMARY KEY, value REAL"+(", label TEXT DEFAULT 'ready'" if version==2 else '')+")"
 def migrate(previous,conn):
  with conn:
   if previous==0: conn.execute('INSERT INTO '+name+' VALUES(1,2.675)')
   else: conn.execute("ALTER TABLE "+name+" ADD COLUMN label TEXT DEFAULT 'ready'")
 return types.SimpleNamespace(name=name,version=version,prototype=prototype,migrate=migrate)
values=[]
for run in range(7):
 path=os.path.join(sys.argv[1],'python-'+str(run)+'.db');p,conn=owner(path);start=time.perf_counter()
 for i in range(50): p.register_table(definition('jobs'+str(i),1))
 elapsed=time.perf_counter()-start;conn.close();p,conn=owner(path);start=time.perf_counter()
 for i in range(50): p.register_table(definition('jobs'+str(i),2))
 elapsed+=time.perf_counter()-start
 for i in range(50):
  assert conn.execute('SELECT * FROM jobs'+str(i)).fetchone()==(1,2.675,'ready')
  assert conn.execute('SELECT version FROM table_registry WHERE name=?',('jobs'+str(i),)).fetchone()==(2,)
 if run>=2: values.append(elapsed*1000)
 conn.close()
print(json.dumps(values))
`;
 const py=spawnSync('/usr/bin/python3',['-c',program,dir],{encoding:'utf8'});assert.equal(py.status,0,py.stderr);const stats=(x:number[])=>{const a=x.toSorted((x,y)=>x-y);return {medianMs:a[2],p95Ms:a.at(-1)};};console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,tables:50,nodeWorker:stats(samples),pythonProvider:stats(JSON.parse(py.stdout)),eventLoopMaxMs:Math.max(...delays),scope:'50 creates plus 50 upgrades, WAL/FULL; open/close and row assertions excluded. Node uses one atomic transaction and worker round trips, Python original registration commits creation/migration/metadata separately. Not equal durability work or hardware timing.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
