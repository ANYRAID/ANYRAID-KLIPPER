import {readFile,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
const bytes=await readFile(new URL('../contracts/moonraker-config-path-reference.json',import.meta.url)),referenceSha256='1acad838310da914e1f8766eb9e8cf1799cf919f2ef063cf6aed26045d9d813d';
if(createHash('sha256').update(bytes).digest('hex')!==referenceSha256)throw Error('Frozen configuration path reference mismatch');
const reference=JSON.parse(bytes.toString()) as {graph:{directories:string[];files:string[];symlinks:Record<string,string>};benchmarks:{name:string;source:string;output:string;iterations:number;warmups:number;samples:number;medianMs:number;maximumMedianRatio:number}[]};
const root=await mkdtemp(join(tmpdir(),'config-path-benchmark-')),cwd=process.cwd(),home=process.env.HOME,results=[];
try{
 for(const name of reference.graph.directories)await mkdir(join(root,name),{recursive:true});for(const name of reference.graph.files)await writeFile(join(root,name),'synthetic');
 for(const [name,target]of Object.entries(reference.graph.symlinks))await symlink(target.replaceAll('$ROOT',root),join(root,name));process.chdir(root);process.env.HOME=join(root,'home');
 for(const row of reference.benchmarks){const reader=new ConfigurationReader(new ConfigurationSource('/synthetic/path-benchmark',{server:{path:row.source}},[])),factory=await MoonrakerTemplateFactory.load(reader,{dataPath:join(root,'data')}),section=reader.section('server');
  try{const batch=()=>{for(let i=0;i<row.iterations;i++)if(section.getPath('path')!==row.output.replaceAll('$ROOT',root))throw Error('Configuration path benchmark output mismatch');};
   for(let i=0;i<row.warmups;i++)batch();const sampleMs=[];for(let i=0;i<row.samples;i++){const start=performance.now();batch();sampleMs.push(performance.now()-start);}
   const medianMs=[...sampleMs].sort((a,b)=>a-b)[Math.floor(sampleMs.length/2)]!,ratio=medianMs/row.medianMs;
   if(factory.toJSON().templates!==0)throw Error('Configuration path retains transient templates');results.push({name:row.name,iterations:row.iterations,warmups:row.warmups,samples:row.samples,sampleMs,medianMs,referenceMedianMs:row.medianMs,ratio,maximumMedianRatio:row.maximumMedianRatio,pass:ratio<=row.maximumMedianRatio});
  }finally{factory.close();}
 }
}finally{process.chdir(cwd);if(home===undefined)delete process.env.HOME;else process.env.HOME=home;await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({schema:1,node:process.version,referenceSha256,results,pass:results.every(row=>row.pass),scope:'Desktop startup configuration getter only: new template compile/render, physical path resolution and NSS lookup; not print throughput, target-board timing or complete default assembly.'},null,2));if(results.some(row=>!row.pass))process.exitCode=1;
