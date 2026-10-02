import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {configureSensors} from '../src/moonraker/sensor-config.ts';
import {sensorConfigurationOracle} from '../test/helpers/sensor-oracle.ts';
const options={type:'MQTT',state_topic:'room/state',state_response_template:'{set_result("t", payload)}',parameter_t:'units=C',history_field_t:'parameter=t\nstrategy=average\nprecision=2\nreport_total=true'};
const sections=Object.fromEntries(Array.from({length:8},(_,i)=>['sensor '+i,options]));
const python=spawnSync('python3',['-c',sensorConfigurationOracle()+`\noptions=json.loads(${JSON.stringify(JSON.stringify(options))})\ntimes=[]\nfor run in range(9):\n start=time.perf_counter()\n for i in range(200):\n  results=[configure_sensor('sensor '+str(n),options) for n in range(8)]\n if run>=2:times.append((time.perf_counter()-start)*1000)\nprint(json.dumps(dict(times=times,results=results)))`],{encoding:'utf8',timeout:120000});assert.equal(python.status,0,python.stderr);const reference=JSON.parse(python.stdout),times=[];
for(let run=0;run<9;run++){
 const start=performance.now();let result;
 for(let i=0;i<200;i++){result=configureSensors(new ConfigurationReader(new ConfigurationSource('/bench.conf',{DEFAULT:{},server:{},...sections},[])),()=>false);result.store.close();}
 if(run>=2)times.push(performance.now()-start);
 for(let n=0;n<8;n++)assert.deepEqual(result!.store.info(String(n),true),reference.results[n].info);
}
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};
console.log(JSON.stringify({node:process.version,warmup:2,samples:7,generations:200,sensors:8,scope:'Startup only: Node bounded config generation versus pinned Python BaseSensor construction; excludes MQTT and template compilation',nodeResult:summary(times),python:summary(reference.times)},null,2));
