import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {configureSensors,readSensorConfiguration} from '../src/moonraker/sensor-config.ts';
import {sensorConfigurationOracle} from './helpers/sensor-oracle.ts';
const reader=(sections:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/config/main.conf',{DEFAULT:{},server:{},...sections},[]));
const common={type:'mqtt',state_topic:'room/telemetry',state_response_template:'{set_result("t", payload)}'};
test('sensor configuration matches pinned upstream defaults, field flags, precision and provider identity',()=>{
 const fixtures=[{name:'sensor room',options:{...common}},{name:'sensor   room',options:{...common,name:'Office',sensor_store_size:'0',parameter_t:'units=C\nname=ignored',history_field_a:'parameter=t\nprecision=٢\ninit_tracker=TRUE\nexclude_paused=yes\nreport_total=true\nstrategy=AVERAGE\nunknown=private',history_field_b:'parameter=t\nreport_maximum=1\nprecision=-1_0'}}];
 const child=spawnSync('python3',['-c',sensorConfigurationOracle()+`\nfixtures=json.loads(${JSON.stringify(JSON.stringify(fixtures))})\nprint(json.dumps([configure_sensor(f['name'],f['options']) for f in fixtures]))`],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout);
 fixtures.forEach((fixture,i)=>{const config=reader({[fixture.name]:fixture.options}),result=configureSensors(config,()=>true);assert.deepEqual(result.store.info('room',true),expected[i].info);assert.deepEqual(config.warnings(),expected[i].warnings);assert.equal(config.validate().length,expected[i].warnings.length);assert.deepEqual(result.sources[0].mqtt,{topic:common.state_topic,template:common.state_response_template,qos:null});result.store.close();});
});
test('configuration preserves state ownership and rejects invalid fields, limits and QoS',()=>{
 for(const extra of [{type:'HTTP'},{sensor_store_size:'-1'},{qos:'3'},{qos:'1.5'},{history_field_a:'strategy=basic'},{history_field_a:'parameter=t\nstrategy=bad'},{history_field_a:'parameter=t\nprecision=1.5'},{history_field_a:'parameter=t\nprecision=9007199254740992'}] as Record<string,string>[]){const config=reader({'sensor room':{...common,...extra}});assert.throws(()=>configureSensors(config,()=>true));assert.equal(config.parsed()['sensor room'].__CONFIG_ERROR__,true);}
 assert.throws(()=>configureSensors(reader({'sensor room':common,'sensor   room':common}),()=>true));
 const config=reader({'sensor room':{...common,qos:'2',history_field_a:'parameter=t\nstrategy=average\nprecision=2\ninit_tracker=true'}}),result=configureSensors(config,()=>true);result.store.update('room',{t:{value:2.675}});result.fields.reset();assert.equal((result.fields.snapshot().data[0] as any).value,2.67);result.sources[0].sensor.history![0].parameter='other';result.store.update('room',{t:{value:4}});assert.equal((result.fields.snapshot().data[0] as any).value,4);assert.equal(result.sources[0].mqtt.qos,2);result.store.close();
});
