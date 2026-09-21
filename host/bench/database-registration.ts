import {statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseOracle} from '../test/helpers/database-oracle.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'db-registration-')),samples:number[]=[],delays:number[]=[];
try{
 for(let round=0;round<9;round++){const store=await DatabaseStore.open({path:join(dir,`node-${round}.db`)}),loop=monitorEventLoopDelay({resolution:1});loop.enable();try{const start=performance.now();for(let i=0;i<100;i++)await store.registerLocalNamespace(`component${i}`,{forbidden:i%2===0});for(let i=0;i<100;i++)await store.unregisterLocalNamespace(`component${i}`);const elapsed=performance.now()-start;assert.deepEqual(await store.get('database','protected_namespaces'),['moonraker']);assert.deepEqual(await store.get('database','forbidden_namespaces'),['database']);if(round>=2){samples.push(elapsed);delays.push(loop.max/1e6);}}finally{loop.disable();await store.close();}}
 const base=databaseOracle().slice(0,databaseOracle().indexOf('def main():')),program=base+String.raw`
import os
component=next(n for n in source.body if isinstance(n,ast.ClassDef) and n.name=='MoonrakerDatabase')
body=[n for n in component.body if isinstance(n,ast.FunctionDef) and n.name in {'register_local_namespace','unregister_local_namespace'}]
exec('from __future__ import annotations\nclass Component:\n'+textwrap.indent(ast.unparse(ast.Module(body=body,type_ignores=[])),'    '))
NamespaceWrapper=lambda *args: None
samples=[]
for run in range(9):
 provider,conn=create(os.path.join(sys.argv[1],'python-'+str(run)+'.db'));conn.execute('PRAGMA journal_mode=WAL');conn.execute('PRAGMA synchronous=FULL')
 owner=Component();owner.server=Server();owner.registered_namespaces={'database','moonraker'};owner.protected_namespaces={'moonraker'};owner.forbidden_namespaces={'database'};owner.db_provider=provider
 owner.insert_item=lambda ns,key,value: provider.insert_item(conn,ns,key,value)
 start=time.perf_counter()
 for i in range(100): owner.register_local_namespace('component'+str(i),i%2==0)
 for i in range(100): owner.unregister_local_namespace('component'+str(i))
 elapsed=(time.perf_counter()-start)*1000
 assert provider.get_item(conn,'database','protected_namespaces')==['moonraker']
 assert provider.get_item(conn,'database','forbidden_namespaces')==['database']
 if run>=2: samples.append(elapsed)
 conn.close()
print(json.dumps(samples))
`;
 const result=spawnSync('/usr/bin/python3',['-c',program,dir],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);const stats=(samples:number[])=>{const sorted=samples.toSorted((a,b)=>a-b);return {medianMs:sorted[3],p95Ms:sorted[6]};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),registrations:100,unregistrations:100,nodeWorker:stats(samples),pythonSynchronousInitialization:stats(JSON.parse(result.stdout)),eventLoopMaxMs:Math.max(...delays),scope:'WAL/FULL; Node includes Worker dispatch and wrapper construction, pinned Python methods use synchronous provider initialization with stub wrapper; not equivalent runtime-thread scheduling or hardware acceptance'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
