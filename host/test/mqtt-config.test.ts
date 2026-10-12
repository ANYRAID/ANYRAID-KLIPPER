import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir,readFile,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,relative} from 'node:path';
import {tmpdir,hostname,userInfo} from 'node:os';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readMqttSensorOptions} from '../src/moonraker/mqtt-config.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
import {configureNativeSensorsFromConfig} from '../src/moonraker/native-sensor-config.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
import {setTimeout as delay} from 'node:timers/promises';
const referenceBytes=await readFile(new URL('../contracts/mqtt-template-components-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(referenceBytes).digest('hex'),'c0cc47e7adc1f5fd815a6ddea8289affe190d75a86c7707ec6b7bb5917da5859');
const reference=JSON.parse(referenceBytes.toString());
const reader=(options:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},mqtt:options},[]));
test('MQTT raw password paths expand named users and preserve braces, parent traversal and private errors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-path-')),info=userInfo(),home=process.env.HOME;let factory:MoonrakerTemplateFactory|undefined;
 try{
  await mkdir(join(dir,'real','nested'),{recursive:true});await symlink('real/nested',join(dir,'link'));await writeFile(join(dir,'real','{password}'),'physical\n');await writeFile(join(dir,'{password}'),'lexical\n');await writeFile(join(dir,'credential'),'synthetic-home\n');
  process.env.HOME=dir;
  const named='~'+info.username+'/'+relative(info.homedir,dir)+'/credential';
  for(const path of [named,'./~//credential'])assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:path}))).password,'synthetic-home');
  assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:named}),{home:'/wrong'})).password,'synthetic-home');
  const config=reader({address:'localhost',password_file:'link/../{password}'});factory=await MoonrakerTemplateFactory.load(config,{dataPath:dir});
  assert.equal((await readMqttSensorOptions(config,{cwd:dir})).password,'physical');assert.equal(config.parsed().mqtt.password_file,'link/../{password}');assert.equal(factory.toJSON().templates,0);
  process.env.HOME='relative';await mkdir(join(dir,'relative'));await writeFile(join(dir,'relative','credential'),'relative-home\n');assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:'./~/credential'}),{cwd:dir})).password,'relative-home');
  process.env.HOME='';const fromRoot='~/'+join(dir,'credential').slice(1);assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:fromRoot}))).password,'synthetic-home');
  delete process.env.HOME;assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:'~/'+relative(info.homedir,dir)+'/credential'}))).password,'synthetic-home');
  for(const path of ['~anyraid_missing_user_7281/credential','\0invalid']){const rejected=reader({address:'localhost',password_file:path,password:'override'});await assert.rejects(readMqttSensorOptions(rejected),error=>error instanceof Error&&error.message==='[mqtt]: Unable to load connection configuration');assert.equal(rejected.parsed().mqtt.__CONFIG_ERROR__,true);}
 }finally{factory?.close();if(home===undefined)delete process.env.HOME;else process.env.HOME=home;await rm(dir,{recursive:true,force:true});}
});
test('MQTT connection configuration matches pinned upstream defaults and password precedence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-config-'));
 try{
  const path=join(dir,'credential');await writeFile(path,'\u0085 local-test-value \n');
  for(const row of reference.rows.slice(0,8)){
   const options=Object.fromEntries(Object.entries(row.options).map(([key,value])=>[key,value==='$PASSWORD_FILE'?path:value])) as Record<string,string>;
   const expected={...row.result,instanceName:row.result.instanceName==='$HOSTNAME'?hostname():row.result.instanceName};assert.deepEqual(await readMqttSensorOptions(reader(options)),expected);
  }
  assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:'~/credential'}),{home:dir})).password,'local-test-value');
  assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:'credential'}),{cwd:dir})).password,'local-test-value');
  await writeFile(path,'\ufefffirst\r\nsecond\rthird\n');assert.equal((await readMqttSensorOptions(reader({address:'localhost',password_file:path}))).password,'\ufefffirst\nsecond\nthird');
  const templated=await readMqttSensorOptions(reader({address:'localhost',username:'{user}',password:'{password}'}),{render:async source=>source==='{user}'?' user ':' rendered '});assert.equal(templated.username,'user');assert.equal(templated.password,'rendered');
 }finally{await rm(dir,{recursive:true,force:true});}
});
for(const [index,row] of reference.rows.entries())test(`shared MQTT credential factory matches frozen upstream case ${index}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-shared-config-'));let factory:MoonrakerTemplateFactory|undefined;
 try{
  const path=join(dir,'credential');await writeFile(path,'\u0085 local-test-value \n');await writeFile(join(dir,'moonraker.secrets'),JSON.stringify(reference.secrets));
  const options=Object.fromEntries(Object.entries(row.options).map(([key,value])=>[key,value==='$PASSWORD_FILE'?path:value])) as Record<string,string>,config=reader(options);factory=await MoonrakerTemplateFactory.load(config,{dataPath:dir});
  if(row.error)await assert.rejects(readMqttSensorOptions(config),error=>error instanceof Error&&error.message==='[mqtt]: Unable to load connection configuration');
  else assert.deepEqual(await readMqttSensorOptions(config),{...row.result,instanceName:row.result.instanceName==='$HOSTNAME'?hostname():row.result.instanceName});
  assert.equal(factory.toJSON().templates,0);assert.equal(factory.toJSON().asyncInitialized,false);
  const publicCopy=JSON.stringify(config.snapshot());for(const value of ['fixture-user','fixture-password','fixture-value'])assert(!publicCopy.includes(value));
  for(const name of ['username','password'])if(Object.hasOwn(options,name)){assert.equal(config.snapshot().original.mqtt[name],'<redacted>');if(!row.error)assert.equal(config.parsed().mqtt[name],'<redacted>');}
 }finally{factory?.close();await rm(dir,{recursive:true,force:true});}
});
test('MQTT shared credentials retain one private generation and release handles on override/file failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-shared-lifetime-'));let factory:MoonrakerTemplateFactory|undefined;
 try{
  const config=reader({address:'localhost',username:'{secrets["mqtt"]["user"]}',password:'{secrets["mqtt"]["password"]}'});await writeFile(join(dir,'moonraker.secrets'),JSON.stringify(reference.secrets));factory=await MoonrakerTemplateFactory.load(config,{dataPath:dir});
  await writeFile(join(dir,'moonraker.secrets'),'{"mqtt":{"user":"next-user","password":"next-password"}}');
  for(let i=0;i<80;i++){const value=await readMqttSensorOptions(config);assert.equal(value.username,'fixture-user');assert.equal(value.password,'fixture-password');assert.equal(factory.toJSON().templates,0);}
  await assert.rejects(readMqttSensorOptions(config,{render:()=>{throw Error('Must not replace the private owner');}}));assert.equal(factory.toJSON().closed,false);assert.equal(factory.toJSON().templates,0);
  const missing=reader({address:'localhost',username:'{secrets["mqtt"]["user"]}',password_file:join(dir,'missing'),password:'override'}),release=missing.bindTemplates(factory);
  try{await assert.rejects(readMqttSensorOptions(missing));assert.equal(factory.toJSON().templates,0);}finally{release();}
  factory.close();await assert.rejects(readMqttSensorOptions(config));
 }finally{factory?.close();await rm(dir,{recursive:true,force:true});}
});
test('configured native sensor transport sends shared credentials and receives real loopback MQTT telemetry',{timeout:5000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-shared-transport-')),peer=await mqttPeer();let factory:MoonrakerTemplateFactory|undefined,generation:Awaited<ReturnType<typeof configureNativeSensorsFromConfig>>|undefined;
 try{
  await writeFile(join(dir,'moonraker.secrets'),JSON.stringify(reference.secrets));
  const config=new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},mqtt:{address:'127.0.0.1',port:String(peer.port),username:'{secrets["mqtt"]["user"]}',password:'{secrets["mqtt"]["password"]}'},'sensor room':{type:'MQTT',state_topic:'room/telemetry',state_response_template:'{set_result("t", payload | float)}'}},[]));factory=await MoonrakerTemplateFactory.load(config,{dataPath:dir});
  generation=await configureNativeSensorsFromConfig(config,()=>false);assert.equal(peer.packets.length,0);assert.equal(factory.toJSON().templates,1);
  await generation.sensorTransport.start();const connect=peer.packets.find(packet=>packet.cmd==='connect');assert(connect&&connect.cmd==='connect');assert.equal(connect.username,'fixture-user');assert.equal(connect.password?.toString(),'fixture-password');
  peer.publish('room/telemetry','27.125');const deadline=performance.now()+1000;while(generation.receivers[0].status.accepted===0&&performance.now()<deadline)await delay(5);assert.equal(generation.receivers[0].status.accepted,1);assert.equal(generation.sensors.info('room').values.t,27.125);
  await generation.close();assert.equal(generation.sensorTransport.status.closed,true);assert.equal(generation.receivers[0].status.closed,true);assert.equal(factory.toJSON().templates,0);assert.equal(factory.toJSON().closed,false);
 }finally{await generation?.close();factory?.close();await peer.close();await rm(dir,{recursive:true,force:true});}
});
test('MQTT config rejects malformed, unsupported and oversized inputs without disclosing credentials',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mqtt-config-'));
 try{
  const tooLarge=join(dir,'large'),invalid=join(dir,'invalid');await writeFile(tooLarge,'x'.repeat(65536));await writeFile(invalid,Buffer.from([0xff]));await mkdir(join(dir,'folder'));
  for(const options of [{port:'0'},{default_qos:'3'},{enable_tls:'maybe'},{mqtt_protocol:'v6'},{mqtt_protocol:'MQTTv311'},{username:'{secret}'},{password:'{secret}'},{password_file:join(dir,'missing'),password:'override'},{password_file:tooLarge},{password_file:invalid},{password_file:join(dir,'folder')},{address:'bad host'},{instance_name:'bad/#'}] as Record<string,string>[]){
   const config=reader({address:'localhost',password:'sensitive-test-marker',...options});await assert.rejects(readMqttSensorOptions(config),error=>error instanceof Error&&error.message==='[mqtt]: Unable to load connection configuration'&&!String(error).includes('sensitive-test-marker'));assert.equal(config.parsed().mqtt.__CONFIG_ERROR__,true);
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
