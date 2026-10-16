// Frozen real upstream getpath; daily runs require no Python or source checkout.
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
import {readKlippyBinding} from '../src/moonraker/klippy-config.ts';
const bytes=await readFile(new URL('../contracts/moonraker-config-path-reference.json',import.meta.url)),referenceSha256='1acad838310da914e1f8766eb9e8cf1799cf919f2ef063cf6aed26045d9d813d';
assert.equal(createHash('sha256').update(bytes).digest('hex'),referenceSha256);
const reference=JSON.parse(bytes.toString()) as {upstream:{revision:string;runtime:string};graph:{directories:string[];files:string[];symlinks:Record<string,string>};benchmarks:{name:string;source:string;output:string;iterations:number;warmups:number;samples:number;medianMs:number;maximumMedianRatio:number}[]};
const root=await mkdtemp(join(tmpdir(),'kp-')),cwd=process.cwd(),home=process.env.HOME,results=[];
try{
 for(const dir of reference.graph.directories)await mkdir(join(root,dir),{recursive:true});for(const file of reference.graph.files)await writeFile(join(root,file),'synthetic');for(const [name,target]of Object.entries(reference.graph.symlinks))await symlink(target.replaceAll('$ROOT',root),join(root,name));
 process.chdir(root);process.env.HOME=join(root,'home');
 for(const row of reference.benchmarks){const config=new ConfigurationReader(new ConfigurationSource('/synthetic/config',{server:{klippy_uds_address:row.source}},[])),owner=await MoonrakerTemplateFactory.load(config,{dataPath:root});
  try{const batch=async()=>{for(let i=0;i<row.iterations;i++)assert.equal((await readKlippyBinding(config)).path,row.output.replaceAll('$ROOT',root));assert.equal(owner.toJSON().templates,0);};
   for(let i=0;i<row.warmups;i++)await batch();const sampleMs=[];for(let i=0;i<row.samples;i++){const start=performance.now();await batch();sampleMs.push(performance.now()-start);}
   const medianMs=[...sampleMs].sort((a,b)=>a-b)[Math.floor(sampleMs.length/2)],ratio=medianMs/row.medianMs;results.push({name:row.name,iterations:row.iterations,warmups:row.warmups,samples:row.samples,sampleMs,medianMs,referenceMedianMs:row.medianMs,ratio,maximumMedianRatio:row.maximumMedianRatio,pass:ratio<=row.maximumMedianRatio});
  }finally{owner.close();}
 }
}finally{process.chdir(cwd);if(home===undefined)delete process.env.HOME;else process.env.HOME=home;await rm(root,{recursive:true,force:true});}
const pass=results.every(row=>row.pass);console.log(JSON.stringify({schema:1,node:process.version,upstream:reference.upstream,referenceSha256,results,pass,scope:'Prepared shared Klippy binding: compile/render, expanduser, physical resolve and socket bounds against original getpath startup budget; excludes factory setup, printing and target-board timing.'},null,2));if(!pass)process.exitCode=1;
