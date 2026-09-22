import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readMqttSensorOptions} from '../src/moonraker/mqtt-config.ts';
import {mqttConfigurationOracle} from './helpers/mqtt-config-oracle.ts';
const reader=(options:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},mqtt:options},[]));
test('MQTT connection configuration matches pinned upstream defaults and password precedence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-config-'));
 try{
  const path=join(dir,'credential');await writeFile(path,'\u0085 local-test-value \n');
  const fixtures:Record<string,string>[]=[{address:'localhost'},{address:'localhost',enable_tls:'yes'},{address:'localhost',port:'٨٨٨٣',default_qos:'٢',client_id:'test-client',username:' user ',password:' value '},{address:'localhost',password_file:path},{address:'localhost',password_file:path,password:' override '},{address:'localhost',username:'',password:''}];
  const child=spawnSync('python3',['-c',mqttConfigurationOracle()+`\nprint(json.dumps([configure(c) for c in json.loads(${JSON.stringify(JSON.stringify(fixtures))})]))`],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout);
  for(let i=0;i<fixtures.length;i++)assert.deepEqual(await readMqttSensorOptions(reader(fixtures[i])),expected[i]);
  assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:'~/credential'}),{home:dir})).password,'local-test-value');
  assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:'credential'}),{cwd:dir})).password,'local-test-value');
  await writeFile(path,'\ufefffirst\r\nsecond\rthird\n');assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:path}))).password,'\ufefffirst\nsecond\nthird');
  const templated=await readMqttSensorOptions(reader({address:'localhost',username:'{user}',password:'{password}'}),{render:async source=>source==='{user}'?' user ':' rendered '});assert.equal(templated.username,'user');assert.equal(templated.password,'rendered');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('MQTT config rejects malformed, unsupported and oversized inputs without disclosing credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-config-'));
 try{
  const tooLarge=join(dir,'large'),invalid=join(dir,'invalid');await writeFile(tooLarge,'x'.repeat(65536));await writeFile(invalid,Buffer.from([0xff]));await mkdir(join(dir,'folder'));
  for(const options of [{port:'0'},{default_qos:'3'},{enable_tls:'maybe'},{mqtt_protocol:'v5'},{mqtt_protocol:'v3.1'},{username:'{secret}'},{password:'{secret}'},{password_file:join(dir,'missing'),password:'override'},{password_file:tooLarge},{password_file:invalid},{password_file:join(dir,'folder')},{address:'bad host'}] as Record<string,string>[]){
   const config=reader({address:'localhost',password:'sensitive-test-marker',...options});await assert.rejects(readMqttSensorOptions(config),error=>error instanceof Error&&error.message==='[mqtt]: Unable to load connection configuration'&&!String(error).includes('sensitive-test-marker'));assert.equal(config.parsed().mqtt.__CONFIG_ERROR__,true);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
