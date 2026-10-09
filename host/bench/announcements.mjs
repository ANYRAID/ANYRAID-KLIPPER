import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdtemp,rm,readdir,lstat,readlink,realpath} from 'node:fs/promises';
import {join,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {monitorEventLoopDelay} from 'node:perf_hooks';
const [input,output]=process.argv.slice(2);
assert(input&&output,'Usage: node host/bench/announcements.mjs compiled-product report.json');
assert.equal(Number(process.versions.node.split('.')[0]),26);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const bundle=await realpath(input),module=name=>import(pathToFileURL(join(bundle,'host/src',name)));
const {verifyProductBundle}=await module('runtime/product-service-unit.js');
await verifyProductBundle(bundle);
const dependencies=async()=>{
 const root=join(bundle,'node_modules'),info=await lstat(root);assert(info.isDirectory()&&!info.isSymbolicLink());
 for(const name of ['typescript','minijinja-js'])await assert.rejects(lstat(join(root,name)),{code:'ENOENT'});
 const digest=createHash('sha256');digest.update('anyraid-acceptance-dependencies-v1\0');
 const walk=async path=>{for(const e of(await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  const file=join(path,e.name),name=relative(root,file).replaceAll('\\','/');
  if(e.isDirectory()){digest.update('directory\0'+name+'\0');await walk(file);}
  else if(e.isFile())digest.update('file\0'+name+'\0'+hash(await readFile(file))+'\0');
  else if(e.isSymbolicLink()){const target=await readlink(file),physical=relative(root,await realpath(file));assert(!isAbsolute(target)&&physical!=='..'&&!physical.startsWith('..'+sep));digest.update('link\0'+name+'\0'+target+'\0');}
  else throw Error('Unexpected dependency entry');
 }};
 await walk(root);return digest.digest('hex');
};
const identity={path:bundle,manifestSha256:hash(await readFile(join(bundle,'build-info.json'))),dependenciesSha256:await dependencies()};
const budget={cachedMedianMs:2,cachedP95Ms:5,busyRelative:'A*1.2+2ms',eventLoopP99Ms:10,eventLoopMaxMs:50,updateMs:3000,outerDeadlineSeconds:60};
await writeFile(output+'.plan.json',JSON.stringify({schema:1,node:process.version,identity,budget,layout:'ABBA: query-only A1, update B1, update B2, query-only A2; three warmups then sixteen samples each; one hundred cached reads per sample.',scope:'Near-capacity cached announcements and worker RSS updates in the compiled product; desktop only, not target-board printing proof.'},null,2)+'\n',{flag:'wx'});
const {DatabaseStore}=await module('moonraker/database.js'),{Announcements}=await module('moonraker/announcements.js'),{ConfigurationReader}=await module('moonraker/config-reader.js'),{ConfigurationSource}=await module('moonraker/config-source.js');
const root=await mkdtemp(join(process.env.TMPDIR??'/home/dek02/.cache/codex/tmp','announcements-bench-')),db=await DatabaseStore.open({path:join(root,'db.sqlite')});
const description='x'.repeat(1750),entries=Array.from({length:256},(_,i)=>({entry_id:'moonraker/entry/'+i,title:'Near-capacity notice',url:null,description,priority:'normal',date:1700000000+i,dismissed:false,date_dismissed:null,dismiss_wake:null,source:'moonlight',feed:'moonraker'}));
const value={version:1,entries,storedFeeds:[],etags:{},localVersions:{}},bytes=Buffer.byteLength(JSON.stringify(value));assert(bytes<=524288&&bytes>=450000);
await db.insert('native_announcements','catalogue',value);
let generation=0;
const fetchFeed=async()=>{
 const items=entries.map((entry,i)=>'<item><guid>'+ (i===255?'moonraker/entry/replacement-'+generation:entry.entry_id)+'</guid><title>Near-capacity notice</title><description>'+description+'</description><category>normal</category><pubDate>Wed, 07 Oct 2026 01:02:03 GMT</pubDate></item>').join('');
 return new Response('<rss><channel><title>Moonraker</title>'+items+'</channel></rss>',{headers:{etag:'"generation-'+generation+'"'}});
};
const reader=new ConfigurationReader(new ConfigurationSource('/benchmark.conf',{server:{},announcements:{enable_moonlight:'true'}},[])),owner=new Announcements(reader,db,()=>{},{fetch:fetchFeed});
let histogram;const samples=[],warmups=[],phaseLoops=[];
const immediate=()=>new Promise(resolve=>setImmediate(resolve));
const quantile=(values,q)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(q*sorted.length)-1)];};
try{
 await owner.start();
 const sample=async(label,busy,warm)=>{
  generation++;let update;const updateStart=performance.now();
  if(busy)update=owner.update({subscriptions:['moonraker']},new AbortController().signal);
  const reads=[];for(let index=0;index<100;index++){const start=performance.now(),result=owner.list();assert.equal(result.entries.length,256);reads.push(performance.now()-start);await immediate();}
  let updateMs=null;if(update){const result=await update;updateMs=performance.now()-updateStart;assert.equal(result.modified,true);assert.equal(owner.status.updateFailed,false);}
  const row={label,busy,reads,updateMs};(warm?warmups:samples).push(row);
 };
 for(const [label,busy] of [['A1',false],['B1',true],['B2',true],['A2',false]]){
  for(let index=0;index<3;index++)await sample(label,busy,true);
  // Re-enabling the same histogram includes the disabled warmup gap in Node
  // 26. Use a fresh timer for each measured phase; retain every phase result.
  histogram=monitorEventLoopDelay({resolution:1});histogram.enable();for(let index=0;index<16;index++)await sample(label,busy,false);histogram.disable();
  phaseLoops.push({label,p99Ms:histogram.percentile(99)/1e6,maxMs:histogram.max/1e6});
 }
 const describe=busy=>{const rows=samples.filter(s=>s.busy===busy),values=rows.flatMap(s=>s.reads);return {samples:values.length,medianMs:quantile(values,.5),p95Ms:quantile(values,.95),maxMs:Math.max(...values)};};
 const a=describe(false),b=describe(true),loop={phases:phaseLoops,p99Ms:Math.max(...phaseLoops.map(p=>p.p99Ms)),maxMs:Math.max(...phaseLoops.map(p=>p.maxMs))};
 const checks={cached:a.medianMs<=budget.cachedMedianMs&&a.p95Ms<=budget.cachedP95Ms,busy:b.medianMs<=Math.min(budget.cachedMedianMs,a.medianMs*1.2+2)&&b.p95Ms<=Math.min(budget.cachedP95Ms,a.p95Ms*1.2+2),eventLoop:loop.p99Ms<=budget.eventLoopP99Ms&&loop.maxMs<=budget.eventLoopMaxMs,updates:samples.filter(s=>s.busy).every(s=>s.updateMs<=budget.updateMs)};
 await owner.close();await db.close();await verifyProductBundle(bundle);assert.equal(await dependencies(),identity.dependenciesSha256);assert.equal(hash(await readFile(join(bundle,'build-info.json'))),identity.manifestSha256);
 const report={schema:1,node:process.version,nodeExecutableSha256:hash(await readFile(process.execPath)),identity,storedCatalogueBytes:bytes,budget,a,b,loop,checks,allPassed:Object.values(checks).every(Boolean),warmups,samples,scope:'Isolated desktop measurements of compiled announcements with no concurrent local build/test/install. No target-board, actual client or G3 claim.'};
 await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({...report,warmups:undefined,samples:undefined}));if(!report.allPassed)process.exitCode=1;
}finally{histogram?.disable();await owner.close();await db.close();await rm(root,{recursive:true,force:true});}
