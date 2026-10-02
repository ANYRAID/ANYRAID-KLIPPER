import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {HistoryFileMetadata} from '../src/moonraker/history-file-metadata.ts';
import {FileMetadataStore} from '../src/moonraker/file-metadata.ts';
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-marker-bench-')),db=await DatabaseStore.open({path:join(root,'db')}),loop=monitorEventLoopDelay({resolution:1});
const baseline=new URL('../node_modules/.cache/history-repository-baseline-'+process.pid+'.mjs',import.meta.url);
try{
 const source=execFileSync('git',['show','71ca6512:host/src/moonraker/history-repository.ts'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8'});mkdirSync(new URL('./',baseline),{recursive:true});writeFileSync(baseline,stripTypeScriptTypes(source).replace(/from '(\.\/[^']+)'/g,(_all,path)=>'from '+JSON.stringify(new URL(path,new URL('../src/moonraker/history-repository.ts',import.meta.url)).href)));
 const Original=(await import(baseline.href)).HistoryRepository;
 const history=await HistoryRepository.open(db),fields={size:1000,modified:99,layer_height:.2,notes:'x'.repeat(16384),thumbnails:[]},filename='part.gcode';
 await history.start({filename,start_time:100,total_duration:0,print_duration:0,filament_used:0,metadata:fields,metadata_generation:'mv-1'});await db.sealTableRegistration();
 const base=new FileMetadataStore(),cache=new FileMetadataStore();cache.commit(cache.begin(filename),fields);base.commit(base.begin(filename),{...fields,job_id:'000001',print_start_time:100});
 const provider={historyMetadata:()=>({generation:'mv-1',fields}),metadata:(name:string)=>cache.metadata(name),thumbnails:(name:string)=>cache.thumbnails(name)};
 const view=new HistoryFileMetadata(provider,history),oldView=new HistoryFileMetadata(provider,new Original(db));
 const expected=JSON.stringify(base.metadata(filename)),samples:Record<string,number[]>={cache:[],transactionalOverlay:[],readOnlyOverlay:[]},delays:Record<string,number[]>={cache:[],transactionalOverlay:[],readOnlyOverlay:[]};
 for(let round=0;round<7;round++)for(const mode of round%2?['readOnlyOverlay','transactionalOverlay','cache']:['cache','transactionalOverlay','readOnlyOverlay']){loop.enable();await delay(2);loop.reset();let last='';const before=performance.now();for(let i=0;i<500;i++)last=JSON.stringify(mode==='cache'?base.metadata(filename):mode==='transactionalOverlay'?await oldView.metadata(filename):await view.metadata(filename));const elapsed=performance.now()-before;await delay(2);if(round>=2)delays[mode].push(loop.max/1e6);loop.disable();assert.deepEqual(JSON.parse(last),JSON.parse(expected));if(round>=2)samples[mode].push(elapsed);}
 const summary=Object.fromEntries(Object.entries(samples).map(([name,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [name,{medianMs:sorted[2],p95Ms:sorted[4],roundsMs:values}];}));
 console.log(JSON.stringify({node:process.version,baselineRepository:'71ca6512',filesystemMagic:statfsSync(root).type,requestsPerRound:500,summary,eventLoopMaxMs:Object.fromEntries(Object.entries(delays).map(([name,values])=>[name,Math.max(...values)])),scope:'Metadata responses with 16 KiB notes, including JSON serialization; cache versus old transaction lookup and new read-only lookup on the same Worker engine. Excludes network, real files and hardware scheduling.'},null,2));
}finally{rmSync(baseline,{force:true});loop.disable();await db.close();await rm(root,{recursive:true,force:true});}
