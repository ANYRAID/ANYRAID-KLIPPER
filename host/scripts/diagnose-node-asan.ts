// Bounded diagnostic only; never retries or changes the native acceptance gate.
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,renameSync,mkdirSync,cpSync,readdirSync,statSync} from 'node:fs';
import {tmpdir,cpus,release} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const host=fileURLToPath(new URL('..',import.meta.url));
const options=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i]!,value=process.argv[i+1];if(!['--case','--runs','--workers','--node','--segv','--asan','--wasm-bounds','--js-optimization','--report-parent','--execution'].includes(key)||value===undefined||options.has(key))throw new Error('Use --case empty|strip|motion|history --runs 1..1000 --workers 1..8 --node /path/node --segv default|exclusive --asan on|off --wasm-bounds trap|inline --js-optimization default|off --report-parent /existing/directory --execution source|compiled');options.set(key,value);}
const kind=options.get('--case')??'strip',limit=Number(options.get('--runs')??200),workers=Number(options.get('--workers')??8),node=options.get('--node')??process.execPath,segv=options.get('--segv')??'default',asan=options.get('--asan')??'on',wasmBounds=options.get('--wasm-bounds')??'trap',jsOptimization=options.get('--js-optimization')??'default';
const execution=options.get('--execution')??'source';
const reportParent=options.get('--report-parent')??tmpdir();
if(!['source','compiled'].includes(execution)||execution==='compiled'&&kind!=='motion'||!isAbsolute(reportParent)||!['default','off'].includes(jsOptimization)||!isAbsolute(node)||!['on','off'].includes(asan)||!['trap','inline'].includes(wasmBounds)||kind==='history'&&asan==='off'||!['empty','strip','motion','history'].includes(kind)||!['default','exclusive'].includes(segv)||!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(workers)||workers<1||workers>8)throw new RangeError('Invalid diagnostic options');
let runtime:string|undefined;
if(asan==='on'){const lookup=spawnSync(process.env.CC??'cc',['-print-file-name=libasan.so'],{encoding:'utf8',timeout:10000});if(lookup.status!==0)throw new Error('ASan runtime lookup failed');runtime=lookup.stdout.trim();}
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
const directory=mkdtempSync(join(reportParent,'anyraid-node-asan-')),fixture=join(directory,'fixture.mjs');
// Freeze a JS-only dependency closure before spawning any measured process.
// This isolates runtime TypeScript loading; it is not a production bundle build.
const compiledHashes:Record<string,string>={},frozenSourceHashes:Record<string,string>={};
let sourceFixture:{path:string;sha256:string}|undefined;
let moduleRoot=host,moduleExtension='ts',compilerVersion:string|undefined;
if(execution==='compiled'){
 compilerVersion=(await import('typescript')).version;
 moduleRoot=join(directory,'compiled');moduleExtension='js';mkdirSync(moduleRoot,{recursive:true});
 writeFileSync(join(moduleRoot,'package.json'),JSON.stringify({type:'module'}));
 const relativeFiles=['src/diagnostics/graph-motion.ts','src/diagnostics/motion-filters.ts','src/diagnostics/legacy-motion-shaper.ts','bench/motion-graph-reference.ts','contracts/motion-graph-fixtures.ts'];
 const project=join(directory,'tsconfig.json');
 writeFileSync(project,JSON.stringify({compilerOptions:{target:'ES2024',module:'NodeNext',moduleResolution:'NodeNext',strict:true,skipLibCheck:true,noEmitOnError:true,rewriteRelativeImportExtensions:true,verbatimModuleSyntax:true,rootDir:host,outDir:moduleRoot,types:['node'],typeRoots:[join(host,'node_modules/@types')]},files:relativeFiles.map(p=>join(host,p))}));
 const compiled=spawnSync(process.execPath,[join(host,'node_modules/typescript/bin/tsc'),'-p',project],{encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
 if(compiled.status!==0)throw new Error('Diagnostic JS compilation failed: '+compiled.stdout+compiled.stderr);
 cpSync(join(host,'contracts/motion-retirement.json'),join(moduleRoot,'contracts/motion-retirement.json'));
 cpSync(join(host,'contracts/motion-retirement'),join(moduleRoot,'contracts/motion-retirement'),{recursive:true});
 // Include transitive emitted modules and every reference blob, not only roots.
 const sourceRoot=join(directory,'source');mkdirSync(sourceRoot);
 function freeze(relative:string){for(const entry of readdirSync(join(moduleRoot,relative),{withFileTypes:true})){const path=join(relative,entry.name),original=join(moduleRoot,path);if(entry.isDirectory()){mkdirSync(join(sourceRoot,path));freeze(path);}else if(entry.isFile()){compiledHashes[path]=hash(original);const sourcePath=path.endsWith('.js')?path.slice(0,-3)+'.ts':path;cpSync(path.endsWith('.js')?join(host,sourcePath):original,join(sourceRoot,sourcePath));frozenSourceHashes[sourcePath]=hash(join(sourceRoot,sourcePath));}else throw new Error('Unexpected diagnostic dependency');}}
 freeze('');
}
const motionModule=pathToFileURL(join(moduleRoot,'src/diagnostics/graph-motion.'+moduleExtension)).href;
const referenceModule=pathToFileURL(join(moduleRoot,'bench/motion-graph-reference.'+moduleExtension)).href;
const system={platform:process.platform,arch:process.arch,kernel:release(),cpu:cpus()[0]?.model,cpuAffinity:process.platform==='linux'?/^Cpus_allowed_list:\s*(.*)$/m.exec(readFileSync('/proc/self/status','utf8'))?.[1]:undefined};
const source=kind==='motion'?`console.log('motion:loading');
const {motionPlots,motionPositions}=await import(${JSON.stringify(motionModule)});
const {motionGraphReference}=await import(${JSON.stringify(referenceModule)});
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
if(execution==='compiled'){const path=join(directory,'source-fixture.mjs'),root=join(directory,'source');writeFileSync(path,source.replace(JSON.stringify(motionModule),JSON.stringify(pathToFileURL(join(root,'src/diagnostics/graph-motion.ts')).href)).replace(JSON.stringify(referenceModule),JSON.stringify(pathToFileURL(join(root,'bench/motion-graph-reference.ts')).href)));sourceFixture={path,sha256:hash(path)};}
const env:NodeJS.ProcessEnv={...process.env,LD_PRELOAD:runtime,ASAN_OPTIONS:`detect_leaks=0:abort_on_error=1:${segv==='exclusive'?'handle_segv=2:':''}verbosity=1:log_path=${join(directory,'asan')}`};
// Do not inherit unrelated runtime flags or addon paths into minimal cases.
delete env.NODE_OPTIONS;if(asan==='off'){delete env.LD_PRELOAD;delete env.ASAN_OPTIONS;}for(const key of Object.keys(env))if(key.startsWith('ANYRAID_')&&key.endsWith('_ADDON'))delete env[key];
const addonHashes:Record<string,string>={};
const moduleHashes:Record<string,string>={};
if(kind==='motion')for(const path of ['src/diagnostics/graph-motion.ts','src/diagnostics/motion-filters.ts','src/diagnostics/legacy-motion-shaper.ts','src/diagnostics/stats-svg.ts','bench/motion-graph-reference.ts','contracts/motion-graph-fixtures.ts','contracts/motion-retirement.json'])moduleHashes[path]=hash(join(host,path));
if(kind==='history')for(const [key,name] of Object.entries({TRAPQ:'trapq',STEPCOMPRESS:'stepcompress',SERIALQUEUE:'serialqueue',UNIX_PEER:'unix-peer',SEALED_FILE:'sealed-file',CAN_QUERY:'can-query',AR100_TEST:'ar100-flash-test'})){const path=join(host,'build',name+'-asan.node');env['ANYRAID_'+key+'_ADDON']=path;addonHashes[name]=hash(path);}
const version=spawnSync(node,['--version'],{encoding:'utf8',timeout:10000});if(version.status!==0)throw new Error('Candidate Node cannot start');
const args=[...(execution==='compiled'?['--no-experimental-strip-types']:[]),...(jsOptimization==='off'?['--no-maglev','--no-turbofan']:[]),...(wasmBounds==='inline'?['--disable-wasm-trap-handler']:[]),...(kind==='history'?['--test','--test-reporter=tap','test/step-history.test.ts']:[fixture])];
// Keep a kernel core local to this isolated diagnostic directory. Absolute
// fixture imports make motion independent of cwd; history still needs host.
const childWorkingDirectory=kind==='history'?host:directory;
const corePolicy=process.platform==='linux'?{filter:readFileSync('/proc/self/coredump_filter','utf8').trim(),pattern:readFileSync('/proc/sys/kernel/core_pattern','utf8').trim(),usesPid:readFileSync('/proc/sys/kernel/core_uses_pid','utf8').trim(),limits:readFileSync('/proc/self/limits','utf8').split('\n').find(line=>line.startsWith('Max core file size'))}:undefined;
interface Result {index:number;pid:number|undefined;status:number|null;signal:NodeJS.Signals|null;error?:string;stdout:string;stderr:string;elapsedMs:number}
const results:Result[]=[];let next=0,failed=false;
const startedAt=new Date().toISOString(),started=performance.now();
const metadata={childWorkingDirectory,corePolicy,node,version:version.stdout.trim(),nodeSha256:hash(node),runtime,runtimeSha256:runtime?hash(runtime):undefined,addonHashes,moduleHashes,compiledHashes,frozenSourceHashes,sourceFixture,compilerVersion,execution,system,kind,segv,asan,wasmBounds,jsOptimization,args,limit,workers,fixtureSha256:hash(fixture)};
const active=new Map<ReturnType<typeof spawn>,{index:number;pid:number|undefined}>();
let interruption:NodeJS.Signals|undefined,killTimer:ReturnType<typeof setTimeout>|undefined;
/** A killed parent leaves state=running, never a false completion. Store in a
 * persistent --report-parent when the environment may discard /tmp. */
function checkpoint(state:'running'|'completed'|'failed'|'interrupted'){
 const coreFiles=readdirSync(directory).filter(name=>/^core(?:\.|$)/.test(name)).map(name=>({path:join(directory,name),bytes:statSync(join(directory,name)).size}));
 const path=join(directory,'report.json'),temporary=path+'.tmp';
 writeFileSync(temporary,JSON.stringify({...metadata,startedAt,updatedAt:new Date().toISOString(),elapsedMs:performance.now()-started,state,interruption,active:[...active.values()],coreFiles,results},null,2),{flush:true,mode:0o600});
 renameSync(temporary,path);
}
function interrupt(signal:NodeJS.Signals){
 if(interruption)return;interruption=signal;checkpoint('interrupted');
 for(const child of active.keys())child.kill('SIGTERM');
 killTimer=setTimeout(()=>{for(const child of active.keys())child.kill('SIGKILL');},1000);killTimer.unref();
}
const onInterrupt=()=>interrupt('SIGINT'),onTerminate=()=>interrupt('SIGTERM');
process.on('SIGINT',onInterrupt);process.on('SIGTERM',onTerminate);
checkpoint('running');
console.log(JSON.stringify({directory,kind,node,version:version.stdout.trim(),limit,workers,segv,asan,wasmBounds,jsOptimization,execution,compilerVersion}));
await Promise.all(Array.from({length:workers},async()=>{while(next<limit&&!failed&&!interruption){const index=next++,begin=performance.now();await new Promise<void>(resolve=>{
 const child=spawn(node,args,{cwd:childWorkingDirectory,env,timeout:10000,killSignal:'SIGKILL'});let stdout='',stderr='',error:string|undefined;
 active.set(child,{index,pid:child.pid});checkpoint(interruption?'interrupted':'running');
 const capture=(target:'stdout'|'stderr',chunk:Buffer)=>{if(stdout.length+stderr.length+chunk.length>1024*1024){error='Output budget exceeded';child.kill('SIGKILL');return;}if(target==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();};
 child.stdout.on('data',b=>capture('stdout',b));child.stderr.on('data',b=>capture('stderr',b));child.on('error',e=>{error=e.message;});
 child.on('close',(status,signal)=>{const marker=kind==='motion'?'motion:verified':kind==='strip'?'stripped':kind==='empty'?'started':undefined;if(status===0&&marker&&stdout.trimEnd().split('\n').at(-1)!==marker&&!error)error='Verification completion marker missing';const result={index,pid:child.pid,status,signal,error,stdout,stderr,elapsedMs:performance.now()-begin};results.push(result);active.delete(child);if(status!==0||error){failed=true;console.log(JSON.stringify({index,status,signal,error}));}checkpoint(interruption?'interrupted':'running');resolve();});
 });}}));
checkpoint(interruption?'interrupted':failed?'failed':'completed');
clearTimeout(killTimer);process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onTerminate);
console.log(JSON.stringify({directory,runs:results.length,failures:results.filter(r=>r.status!==0||r.error).length}));
if(interruption)process.exitCode=interruption==='SIGINT'?130:143;else if(failed)process.exitCode=1;
