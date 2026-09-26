// Bounded diagnostic only; never retries or changes the native acceptance gate.
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir,cpus,release} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
const options=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]!,value=process.argv[i+1];if(!['--case','--runs','--workers','--node','--segv','--asan','--wasm-bounds'].includes(key)||value===undefined||options.has(key))throw new Error('Use --case empty|strip|motion|history --runs 1..1000 --workers 1..8 --node /path/node --segv default|exclusive --asan on|off --wasm-bounds trap|inline');options.set(key,value);}
const kind=options.get('--case')??'strip',limit=Number(options.get('--runs')??200),workers=Number(options.get('--workers')??8),node=options.get('--node')??process.execPath,segv=options.get('--segv')??'default',asan=options.get('--asan')??'on',wasmBounds=options.get('--wasm-bounds')??'trap';
if(!isAbsolute(node)||!['on','off'].includes(asan)||!['trap','inline'].includes(wasmBounds)||kind==='history'&&asan==='off'||!['empty','strip','motion','history'].includes(kind)||!['default','exclusive'].includes(segv)||!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(workers)||workers<1||workers>8)throw new RangeError('Invalid diagnostic options');
const runtimeLookup=spawnSync(process.env.CC??'cc',['-print-file-name=libasan.so'],{encoding:'utf8',timeout:10000});if(runtimeLookup.status!==0)throw new Error('ASan runtime lookup failed');
const runtime=runtimeLookup.stdout.trim(),hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const directory=mkdtempSync(join(tmpdir(),'anyraid-node-asan-')),fixture=join(directory,'fixture.mjs');
const system={platform:process.platform,arch:process.arch,kernel:release(),cpu:cpus()[0]?.model,cpuAffinity:process.platform==='linux'?/^Cpus_allowed_list:\s*(.*)$/m.exec(readFileSync('/proc/self/status','utf8'))?.[1]:undefined};
const source=kind==='motion'?`console.log('motion:loading');
const {motionPlots,motionPositions}=await import(${JSON.stringify(new URL('../src/diagnostics/graph-motion.ts',import.meta.url).href)});
const {motionGraphReference}=await import(${JSON.stringify(new URL('../bench/motion-graph-reference.ts',import.meta.url).href)});
const {default:assert}=await import('node:assert/strict');
const profile={order:4,jerkLimit:true},reference=motionGraphReference('weighted4',undefined,profile);
console.log('motion:loaded');
for(let run=0;run<16;run++){
 const positions=motionPositions(profile);assert.equal(positions.length,reference.positions.length);
 positions.forEach((v,i)=>assert.ok(Math.abs(v-reference.positions[i])<=1e-12));
 const panels=motionPlots('weighted4',undefined,profile);assert.equal(panels.length,reference.panels.length);
 panels.forEach((p,i)=>{const r=reference.panels[i];assert.equal(p.plot.curves.length,r.curves.length);p.plot.curves.forEach((c,j)=>{
  const expected=r.curves[j];assert.deepEqual(c.times,expected.times);assert.equal(c.values.length,expected.values.length);
  c.values.forEach((v,k)=>{if(!(Math.abs(v-expected.values[k])<=[1e-8,1e-4,1e-10][i])){
   const repeated=motionPlots('weighted4',undefined,profile)[i].plot.curves[j].values[k];
   const bits=x=>{const bytes=Buffer.alloc(8);bytes.writeDoubleLE(x);return bytes.readBigUInt64LE();};
   const xor='0x'+(bits(v)^bits(expected.values[k])).toString(16);
   throw new Error('Motion numerical mismatch '+JSON.stringify({run,panel:i,curve:j,index:k,actual:v,expected:expected.values[k],error:v-expected.values[k],xor,repeated,nearby:c.values.slice(Math.max(0,k-2),k+3),reference:expected.values.slice(Math.max(0,k-2),k+3)}));
  }});
 });});
}
console.log('motion:verified');
`:kind==='strip'?`import {stripTypeScriptTypes} from 'node:module';
const source=Array.from({length:200},(_,i)=>\`export function f\${i}(x:number):number { return x+\${i}; }\`).join(String.fromCharCode(10));
for(let i=0;i<40;i++)stripTypeScriptTypes(source);
console.log('stripped');\n`:`console.log('started');\n`;
writeFileSync(fixture,source);
const env:NodeJS.ProcessEnv={...process.env,LD_PRELOAD:runtime,ASAN_OPTIONS:`detect_leaks=0:abort_on_error=1:${segv==='exclusive'?'handle_segv=2:':''}verbosity=1:log_path=${join(directory,'asan')}`};
// Do not inherit unrelated runtime flags or addon paths into minimal cases.
delete env.NODE_OPTIONS;if(asan==='off'){delete env.LD_PRELOAD;delete env.ASAN_OPTIONS;}for(const key of Object.keys(env))if(key.startsWith('ANYRAID_')&&key.endsWith('_ADDON'))delete env[key];
const addonHashes:Record<string,string>={};
const moduleHashes:Record<string,string>={};
if(kind==='motion')for(const path of ['src/diagnostics/graph-motion.ts','src/diagnostics/motion-filters.ts','src/diagnostics/legacy-motion-shaper.ts','src/diagnostics/stats-svg.ts','bench/motion-graph-reference.ts','contracts/motion-graph-fixtures.ts','contracts/motion-retirement.json'])moduleHashes[path]=hash(join(host,path));
if(kind==='history')for(const [key,name] of Object.entries({TRAPQ:'trapq',STEPCOMPRESS:'stepcompress',SERIALQUEUE:'serialqueue',UNIX_PEER:'unix-peer',SEALED_FILE:'sealed-file',CAN_QUERY:'can-query',AR100_TEST:'ar100-flash-test'})){const path=join(host,'build',name+'-asan.node');env['ANYRAID_'+key+'_ADDON']=path;addonHashes[name]=hash(path);}
const version=spawnSync(node,['--version'],{encoding:'utf8',timeout:10000});if(version.status!==0)throw new Error('Candidate Node cannot start');
const args=[...(wasmBounds==='inline'?['--disable-wasm-trap-handler']:[]),...(kind==='history'?['--test','--test-reporter=tap','test/step-history.test.ts']:[fixture])];
interface Result {index:number;pid:number|undefined;status:number|null;signal:NodeJS.Signals|null;error?:string;stdout:string;stderr:string}
const results:Result[]=[];let next=0,failed=false;
console.log(JSON.stringify({directory,kind,node,version:version.stdout.trim(),limit,workers,segv,asan,wasmBounds}));
await Promise.all(Array.from({length:workers},async()=>{while(next<limit&&!failed){const index=next++;await new Promise<void>(resolve=>{
 const child=spawn(node,args,{cwd:host,env,timeout:10000,killSignal:'SIGKILL'});let stdout='',stderr='',error:string|undefined;
 const capture=(target:'stdout'|'stderr',chunk:Buffer)=>{if(stdout.length+stderr.length+chunk.length>1024*1024){error='Output budget exceeded';child.kill('SIGKILL');return;}if(target==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();};
 child.stdout.on('data',b=>capture('stdout',b));child.stderr.on('data',b=>capture('stderr',b));child.on('error',e=>{error=e.message;});
 child.on('close',(status,signal)=>{const result={index,pid:child.pid,status,signal,error,stdout,stderr};results.push(result);if(status!==0||error){failed=true;console.log(JSON.stringify({index,status,signal,error}));}resolve();});
 });}}));
writeFileSync(join(directory,'report.json'),JSON.stringify({node,version:version.stdout.trim(),nodeSha256:hash(node),runtime,runtimeSha256:hash(runtime),addonHashes,moduleHashes,system,kind,segv,asan,wasmBounds,limit,workers,fixtureSha256:hash(fixture),results},null,2));
console.log(JSON.stringify({directory,runs:results.length,failures:results.filter(r=>r.status!==0||r.error).length}));
if(failed)process.exitCode=1;
