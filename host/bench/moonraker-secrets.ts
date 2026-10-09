import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {loadSecrets,parseSecretsText,type SecretObject} from '../src/moonraker/secrets.ts';

// Synthetic values only. This script neither reads deployment credentials nor
// prints values. It adds no Python runtime or motion-path dependency.
const value='synthetic-value-'.repeat(4),values=Object.fromEntries(Array.from({length:32},(_,i)=>['section'+i,{password:value,index:String(i)}]));
const json=JSON.stringify(values),ini=Object.entries(values).map(([name,fields])=>'['+name+']\n'+Object.entries(fields).map(([key,text])=>key+'='+text).join('\n')).join('\n');
const inputs={json:{bytes:Buffer.byteLength(json),sha256:createHash('sha256').update(json).digest('hex')},ini:{bytes:Buffer.byteLength(ini),sha256:createHash('sha256').update(ini).digest('hex')}};
const iterations={parse:2000,cached:1000000,load:16},warmups=2,samples=7;
const summary=(runs:number[])=>{const sorted=[...runs].sort((a,b)=>a-b);return {samplesMs:runs,medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*0.95)-1]};};
const timings:Record<string,number[]>={json:[],ini:[],cached:[],load:[]};
const directory=await mkdtemp(join(tmpdir(),'secrets-bench-'));
try{
 const config=join(directory,'moonraker.conf');await writeFile(config,'[server]\n');await writeFile(join(directory,'moonraker.secrets'),json);
 const reader=new ConfigurationReader(await loadConfiguration(config)),owner=await loadSecrets(reader,{dataPath:directory});
 try{
  for(let run=0;run<warmups+samples;run++){
   for(const [format,text]of [['json',json],['ini',ini]] as const){
    let checksum=0;const start=performance.now();for(let i=0;i<iterations.parse;i++)checksum+=((parseSecretsText(text).values.section31 as SecretObject).password as string).length;
    const elapsed=performance.now()-start;assert.equal(checksum,value.length*iterations.parse);if(run>=warmups)timings[format].push(elapsed);
   }
   let checksum=0;const readStart=performance.now();for(let i=0;i<iterations.cached;i++)checksum+=((owner.item('section31') as SecretObject).password as string).length;
   const readMs=performance.now()-readStart;assert.equal(checksum,value.length*iterations.cached);if(run>=warmups)timings.cached.push(readMs);
   const loadStart=performance.now();for(let i=0;i<iterations.load;i++){const generation=await loadSecrets(reader,{dataPath:directory});try{assert.equal((generation.item('section31') as SecretObject).password,value);}finally{generation.close();}}
   if(run>=warmups)timings.load.push(performance.now()-loadStart);
  }
 }finally{owner.close();}
 console.log(JSON.stringify({schema:1,node:process.version,inputs,warmups,samples,iterations,timings:Object.fromEntries(Object.entries(timings).map(([key,runs])=>[key,summary(runs)])),scope:'Local synthetic JSON/INI parsing, private cached lookup and async startup load. No deployment secrets, MCU, real printing, template rendering or target-board budget claim.'}));
}finally{await rm(directory,{recursive:true,force:true});}
