import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
import {readMqttSensorOptions} from '../src/moonraker/mqtt-config.ts';
const capture=process.argv.includes('--capture'),root=await mkdtemp(join(tmpdir(),'mqtt-template-bench-'));
const loads=1000,warmups=2,sampleCount=7,maxRatio=1.5;
try{
 const file=join(root,'password');await writeFile(file,'test-value\n');await writeFile(join(root,'moonraker.secrets'),'{"mqtt":{"username":"test","password":"test-value"}}');
 const results=[];
 for(const mode of ['literal','file','shared'] as const){
  const options={address:'localhost',instance_name:'benchmark',default_qos:'2',...mode==='file'?{password_file:file}:mode==='shared'?{username:'{secrets["mqtt"]["username"]}',password:'{secrets["mqtt"]["password"]}'}:{username:'test',password:'test-value'}};
  const reader=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},mqtt:options},[]));
  const factory=mode==='shared'?await MoonrakerTemplateFactory.load(reader,{dataPath:root}):undefined;
  const render=(source:string)=>{const handle=factory!.createTemplate(source);try{return handle.render();}finally{handle.close();}};
  try{
   const times=[];for(let run=0;run<warmups+sampleCount;run++){
    const begin=performance.now();let value;for(let i=0;i<loads;i++)value=await readMqttSensorOptions(reader,capture&&factory?{render}:{});
    if(run>=warmups)times.push(performance.now()-begin);
    assert.deepEqual(value,{host:'localhost',port:1883,tls:false,defaultQos:2,instanceName:'benchmark',...mode==='file'?{}:{username:'test'},password:'test-value'});
    assert.equal(factory?.toJSON().templates??0,0,'Credential handles must be released after every load');
   }
   results.push({mode,times,medianMs:[...times].sort((a,b)=>a-b)[3]});
  }finally{factory?.close();}
 }
 if(capture)console.log(JSON.stringify({node:process.version,loads,warmups,sampleCount,maxRatio,results},null,2));
 else{
  const bytes=await readFile(new URL('../contracts/mqtt-template-components-reference.json',import.meta.url));
  const reference=JSON.parse(bytes.toString());const budgets=results.map(row=>{const baseline=reference.performance.results.find((value:any)=>value.mode===row.mode).medianMs;return {mode:row.mode,baselineMs:baseline,medianMs:row.medianMs,ratio:row.medianMs/baseline,limit:reference.performance.maxRatio,passed:row.medianMs/baseline<=reference.performance.maxRatio};});
  console.log(JSON.stringify({node:process.version,referenceSha256:createHash('sha256').update(bytes).digest('hex'),loads,warmups,sampleCount,results,budgets,scope:'Prepared MQTT connection getters, bounded password file reads and shared private credential rendering. Factory/file setup excluded; no broker, motion or target-board claim.'},null,2));assert(budgets.every(row=>row.passed),'MQTT credential loading exceeds frozen desktop budget');
 }
}finally{await rm(root,{recursive:true,force:true});}
