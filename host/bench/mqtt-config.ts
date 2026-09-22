import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readMqttSensorOptions} from '../src/moonraker/mqtt-config.ts';
import {mqttConfigurationOracle} from '../test/helpers/mqtt-config-oracle.ts';
const dir=await mkdtemp(join(tmpdir(),'mqtt-config-bench-')),summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
try{
 const path=join(dir,'credential');await writeFile(path,'test-value\n');const cases:Record<string,string>[]=[{address:'localhost',port:'1883',username:'test',password:'test-value',default_qos:'2'},{address:'localhost',password_file:path}],results=[];
 for(const options of cases){
  const child=spawnSync('python3',['-c',mqttConfigurationOracle()+`\noptions=json.loads(${JSON.stringify(JSON.stringify(options))});times=[]\nfor run in range(9):\n start=time.perf_counter()\n for i in range(1000):result=configure(options)\n if run>=2:times.append((time.perf_counter()-start)*1000)\nprint(json.dumps(dict(times=times,result=result)))`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,child.stderr);const reference=JSON.parse(child.stdout),times=[];
  const reader=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},mqtt:options},[]));
  for(let run=0;run<9;run++){let value;const start=performance.now();for(let i=0;i<1000;i++)value=await readMqttSensorOptions(reader);if(run>=2)times.push(performance.now()-start);assert.deepEqual(value,reference.result);}
  results.push({passwordFile:'password_file' in options,node:summary(times),python:summary(reference.times)});
 }
 console.log(JSON.stringify({node:process.version,loads:1000,warmup:2,samples:7,scope:'Connection option loading with prepared configuration; Python executes pinned constructor statements with getter stubs; excludes INI parsing, template compilation, network and printing',results},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
