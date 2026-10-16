import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
import {configureNativeSensorsFromConfig} from '../src/moonraker/native-sensor-config.ts';
import {mqttPeer} from '../test/helpers/mqtt-peer.ts';
const capture=process.argv.includes('--capture'),samples:{startupMs:number;mixedMs:number;messages:number}[]=[];
const information={connected:false,state:'disconnected' as const,components:['application'],failedComponents:[],directories:[],warnings:[],version:'mqtt-components-bench',missingRequirements:[]};
const authorize=(_method:unknown,_params:unknown,context:any)=>assert.equal(context.request.headers['x-api-key'],'benchmark');
for(let run=0;run<9;run++){
 const root=await mkdtemp(join(tmpdir(),'configured-mqtt-components-')),peer=await mqttPeer(),file=join(root,'moonraker.conf');let server:ConfiguredMoonraker|undefined,privateOwner:MoonrakerTemplateFactory|undefined,generation:Awaited<ReturnType<typeof configureNativeSensorsFromConfig>>|undefined;
 try{
  await writeFile(join(root,'moonraker.secrets'),'{"mqtt":{"username":"benchmark","password":"fixture-password"}}');
  await writeFile(file,`[server]\nhost: 127.0.0.1\nport: 0\n[mqtt]\naddress: 127.0.0.1\nport: ${peer.port}\nusername: {secrets["mqtt"]["username"]}\npassword: {secrets["mqtt"]["password"]}\ninstance_name: benchmark\nenable_moonraker_api: false\n[sensor room]\ntype: MQTT\nstate_topic: room/telemetry\nstate_response_template: {set_result("t", payload | float)}\n`);
  const begin=performance.now();
  if(capture){const reader=new ConfigurationReader(await loadConfiguration(file));privateOwner=await MoonrakerTemplateFactory.load(reader,{dataPath:root});generation=await configureNativeSensorsFromConfig(reader,()=>false);server=await ConfiguredMoonraker.load(file,{information,authorize,sensors:generation.sensors,sensorTransport:generation.sensorTransport});}
  else server=await ConfiguredMoonraker.load(file,{information,authorize,templates:{dataPath:root}});
  const address=await server.start(),startupMs=performance.now()-begin,base=`http://127.0.0.1:${address.port}`;
  const connect=peer.packets.find(packet=>packet.cmd==='connect');assert(connect?.cmd==='connect');assert.equal(connect.username,'benchmark');assert.equal(connect.password?.toString(),'fixture-password');
  await rm(file);await rm(join(root,'moonraker.secrets'));
  const start=performance.now();for(let i=1;i<=1000;i++)peer.publish('room/telemetry',String(i));
  for(let i=0;i<100;i++){const response=await fetch(base+'/server/info',{headers:{'x-api-key':'benchmark'}});assert.equal(response.status,200);assert.equal((await response.json() as any).result.klippy_connected,false);}
  const deadline=performance.now()+3000;while(server.sensorTransportStatus!.messages<1000){assert(performance.now()<deadline,'Mixed MQTT benchmark deadline');await new Promise<void>(resolve=>setImmediate(resolve));}
  const response=await fetch(base+'/server/sensors/info?sensor=room',{headers:{'x-api-key':'benchmark'}});assert.equal(response.status,200);assert.equal((await response.json() as any).result.values.t,1000);
  samples.push({startupMs,mixedMs:performance.now()-start,messages:server.sensorTransportStatus!.messages});
 }finally{await server?.close();await generation?.close();privateOwner?.close();await peer.close();await rm(root,{recursive:true,force:true});}
}
const medians=Object.fromEntries((['startupMs','mixedMs'] as const).map(key=>[key,samples.slice(2).map(sample=>sample[key]).sort((a,b)=>a-b)[3]]));
if(capture)console.log(JSON.stringify({node:process.version,warmups:2,samples,medians,maxRatio:1.5},null,2));
else{const reference=JSON.parse(await readFile(new URL('../contracts/configured-mqtt-components-reference.json',import.meta.url),'utf8'));const budgets=Object.entries(medians).map(([key,median])=>({key,median,ratio:median/reference.medians[key],limit:reference.maxRatio,passed:median/reference.medians[key]<=reference.maxRatio}));console.log(JSON.stringify({node:process.version,warmups:2,samples,medians,budgets,scope:'Prepared process loads, actual loopback MQTT CONNECT/SUBACK, HTTP listen and 100 metadata queries mixed with 1000 telemetry messages. Manual external private generation baseline vs configuration-owned generation; no device, printing or target board.'},null,2));assert(budgets.every(row=>row.passed),'Configuration-owned MQTT exceeds frozen budget');}
