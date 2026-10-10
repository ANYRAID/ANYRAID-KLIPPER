import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const script=fileURLToPath(import.meta.url),current=fileURLToPath(new URL('..',import.meta.url));
assert.match(process.versions.node,/^26\./u);
// Freeze before measuring: unchanged non-LDAP server, 200 actual HTTP queries.
const budget={coldRatio:1.15,coldAllowanceMs:5,queryRatio:1.1,queryAllowanceMs:5},queries=200;
if(process.argv[2]==='--child'){
 const host=process.argv[3]!;assert(isAbsolute(host));
 const directory=await mkdtemp(join(tmpdir(),'ldap-config-bench-')),filename=join(directory,'main.conf');
 await writeFile(filename,'[server]\nhost: 127.0.0.1\nport: 0\n');let server:any,db:any;
 try{
  const start=performance.now();
  const [{ConfiguredMoonraker},{DatabaseStore}]=await Promise.all([import(pathToFileURL(join(host,'src/moonraker/configured-server.ts')).href),import(pathToFileURL(join(host,'src/moonraker/database.ts')).href)]);
  db=await DatabaseStore.open({path:join(directory,'metadata.sqlite')});
  server=await ConfiguredMoonraker.loadAuthorized(filename,{information:{connected:false,state:'disconnected',components:['application'],failedComponents:[],directories:[],warnings:[],version:'ldap-config-benchmark',missingRequirements:[]},database:db,authorization:{issuer:'http://printer.test:7125'}});
  const address=await server.start(),coldMs=performance.now()-start,url=`http://127.0.0.1:${address.port}/server/info`,key=server.authorization.localApiKey();
  // HTTP connection and route warmup are separate from measured batch.
  for(let i=0;i<10;i++){const response=await fetch(url,{headers:{'x-api-key':key}});assert.equal(response.status,200);await response.arrayBuffer();}
  const queryStart=performance.now();
  for(let i=0;i<queries;i++){const response=await fetch(url,{headers:{'x-api-key':key}});assert.equal(response.status,200);const body:any=await response.json();assert.equal(body.result.klippy_connected,false);assert(body.result.components.includes('authorization'));}
  console.log(JSON.stringify({coldMs,queryMs:performance.now()-queryStart}));
 }finally{await server?.close();await db?.close();await rm(directory,{recursive:true,force:true});}
}else{
 const baseline=resolve(process.argv[2]??'');assert(process.argv[2],'Provide an exact baseline host source export');
 const run=(host:string)=>new Promise<{coldMs:number;queryMs:number}>((resolve,reject)=>{
  const child=spawn(process.execPath,[script,'--child',host],{stdio:['ignore','pipe','pipe'],env:process.env}),timer=setTimeout(()=>child.kill('SIGTERM'),10000);let output='',error='';
  child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>error+=data);child.once('error',reject);child.once('close',code=>{clearTimeout(timer);if(code!==0){reject(Error('Bounded benchmark child failed: '+code+' '+error));return;}try{resolve(JSON.parse(output));}catch(value){reject(value);}});
 });
 const warmups=2,samples=7,result:{baseline:{coldMs:number;queryMs:number}[];current:{coldMs:number;queryMs:number}[]}={baseline:[],current:[]};
 for(let i=0;i<warmups;i++){await run(baseline);await run(current);}
 for(let i=0;i<samples;i++)for(const group of ['baseline','current','current','baseline'] as const)result[group].push(await run(group==='baseline'?baseline:current));
 const summary=(group:'baseline'|'current',name:'coldMs'|'queryMs')=>{const values=result[group].map(row=>row[name]).toSorted((a,b)=>a-b);return {medianMs:values[Math.ceil(values.length*.5)-1]!,p95Ms:values[Math.ceil(values.length*.95)-1]!};};
 const sourceInventory=async(host:string)=>{const files:{path:string;sha256:string}[]=[];async function visit(path:string){for(const entry of (await readdir(join(host,path),{withFileTypes:true})).toSorted((a,b)=>a.name.localeCompare(b.name))){const name=path+'/'+entry.name;if(entry.isDirectory())await visit(name);else if(entry.isFile())files.push({path:name,sha256:createHash('sha256').update(await readFile(join(host,name))).digest('hex')});}}await visit('src');return {files,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')};};
 const cold={baseline:summary('baseline','coldMs'),current:summary('current','coldMs')},query={baseline:summary('baseline','queryMs'),current:summary('current','queryMs')};
 const coldPass=cold.current.medianMs<=cold.baseline.medianMs*budget.coldRatio+budget.coldAllowanceMs,queryPass=query.current.medianMs<=query.baseline.medianMs*budget.queryRatio+budget.queryAllowanceMs;
 console.log(JSON.stringify({schema:1,node:process.version,warmups,samples,order:'ABBA; 14 fresh processes per group',queries,budget,result,cold,query,coldPass,queryPass,sources:{baseline:await sourceInventory(baseline),current:await sourceInventory(current)},scriptSha256:createHash('sha256').update(await readFile(script)).digest('hex'),scope:'Exact-source, fresh-process default native authorized server startup including module imports, database open, assembly and localhost listening; warmed actual HTTP server/info queries with API-key authorization. Existing dependency/native bytes reused, not rebuilt. No LDAP login, target-board, printing or G3 claim.'},null,2));
 if(!coldPass||!queryPass)process.exitCode=1;
}
