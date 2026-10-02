import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import type {ClientArguments} from '../src/moonraker/client-requests.ts';
import {ClientCalls,encodeClientCall} from '../src/moonraker/client-calls.ts';
import {NotificationFanout} from '../src/moonraker/notifications.ts';
const root=process.env.MOONRAKER_SOURCE;if(!root)throw new Error('Set MOONRAKER_SOURCE');
const pin=JSON.parse(readFileSync(new URL('../contracts/moonraker-upstream.json',import.meta.url),'utf8')).commit;
const fixtures:ClientArguments[]=[null,[],{},{position:[1.25,2,3],text:'中文',exact:'9007199254740993'},[false,0,''],{large:1e20}];
const python=String.raw`
import ast,json,sys,subprocess
assert subprocess.check_output(['git','-C',sys.argv[1],'rev-parse','HEAD'],text=True).strip()==sys.argv[2]
tree=ast.parse(open(sys.argv[1]+'/moonraker/common.py').read())
cls=next(n for n in tree.body if isinstance(n,ast.ClassDef) and n.name=='BaseRemoteConnection')
method=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='call_method')
method.returns=None
for arg in method.args.args: arg.annotation=None
ns={};exec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),'upstream','exec'),ns)
class Client:
 def queue_message(self,msg): self.msg=msg
c=Client();out=[]
for p in json.load(sys.stdin):
 ns['call_method'](c,'agent.result',p);out.append(c.msg)
print(json.dumps(out))
`;
const oracle=spawnSync('/usr/bin/python3',['-c',python,root,pin],{input:JSON.stringify(fixtures),encoding:'utf8'});assert.equal(oracle.status,0,oracle.stderr);
assert.deepEqual(fixtures.map(p=>JSON.parse(encodeClientCall('agent.result',p))),JSON.parse(oracle.stdout));
// Use the pre-refactor implementation as a same-host alternating regression
// baseline, including validation, immutable authorization and capacity checks.
const previous=spawnSync('git',['show','532547e5:host/src/moonraker/notifications.ts'],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});assert.equal(previous.status,0,previous.stderr);
const dir=mkdtempSync(join(tmpdir(),'client-calls-bench-'));
try{
 const file=join(dir,'previous.ts');writeFileSync(file,previous.stdout.replace("'./rpc.ts'",JSON.stringify(new URL('../src/moonraker/rpc.ts',import.meta.url).href)));
 const {NotificationFanout:Previous}=await import(pathToFileURL(file).href);
 const queues={previous:new Previous(),events:new NotificationFanout(),calls:new ClientCalls()},samples={previous:[] as number[],events:[] as number[],calls:[] as number[]};let delivered=0;
 for(const q of Object.values(queues))q.add(1,{signal:new AbortController().signal,authorize(){},send(){delivered++;return true;},disconnect(){throw new Error('Unexpected disconnect');}});
 const payload={position:[1.25,2,3],eventtime:123.25},modes=['previous','events','calls'] as const;
 for(let run=0;run<54;run++)for(const mode of run%2?modes:[...modes].reverse()){
  const start=performance.now();for(let i=0;i<5000;i++){const result=mode==='calls'?queues.calls.dispatchTo(1,'agent.result',payload):queues[mode].dispatchTo(1,'notify_result',[payload]);assert.equal((result as any).sent,1);}
  if(run>=3)samples[mode].push(performance.now()-start);
 }
 assert.equal(delivered,54*3*5000);for(const q of Object.values(queues))await q.close();
 const stats=(s:number[])=>{s.sort((a,b)=>a-b);return {medianMs:s[25],p95Ms:s[48]};};
 console.log(JSON.stringify({node:process.version,oracleFixtures:fixtures.length,upstream:pin,warmup:3,samples:51,callsPerSample:5000,results:Object.fromEntries(modes.map(m=>[m,stats(samples[m])])),scope:'Synchronous authorized delivery queue and encoding; prior commit event queue is regression baseline. No socket, printer deadline or Python performance claim.'},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
