import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {inspect} from 'node:util';
import {MoonrakerTemplateFactory,type TemplateFactoryOptions} from '../src/moonraker/template-factory.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {SharedSensorMessages,NativeSensorMessages,configureNativeSensorsFromConfig} from '../src/moonraker/native-sensor-config.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {ConfiguredMoonraker} from '../src/moonraker/configured-server.ts';import {templateFloatValue} from '../src/moonraker/template-wire.ts';
import {mqttPeer} from './helpers/mqtt-peer.ts';
async function fixture(run:(factory:MoonrakerTemplateFactory,root:string)=>Promise<void>,options:TemplateFactoryOptions={}){
 const root=await mkdtemp(join(tmpdir(),'shared-sensor-components-')),reader=new ConfigurationReader(new ConfigurationSource(join(root,'moonraker.conf'),{DEFAULT:{},server:{}},[]));await writeFile(join(root,'moonraker.secrets'),'{"calibration":{"gain":"1.25"},"marker":"synthetic-private"}');const factory=await MoonrakerTemplateFactory.load(reader,{dataPath:root},options);
 try{await run(factory,root);}finally{factory.close();await rm(root,{recursive:true,force:true});}
}
function store(){const fields=new HistoryFields(()=>true),store=new SensorStore();store.register({id:'room',type:'MQTT',history:[{name:'t',parameter:'t',strategy:'accumulate',description:'Temperature'}]},fields);return {store,fields};}
test('shared sensor batches preserve typed JSON, boolean, Unicode floats and signed zero',()=>fixture(async factory=>{
 const {store:s,fields}=store(),source='{% set d=payload|fromjson %}{set_result("i",d.i)}{set_result("f",d.f)}{set_result("b",d.b)}{set_result("z",d.z)}{set_result("text",d.text)}{set_result("t",secrets["calibration"]["gain"]|float * d.f)}',receiver=new SharedSensorMessages(s,'room',factory.createTemplate(source));
 try{assert(receiver.receive(Buffer.from('{"i":1,"f":1.0,"b":true,"z":-0.0,"text":" ١_٢.５e-１ "}')));assert.deepEqual(s.info('room').values,{i:1,f:1,b:true,z:-0,text:1.25,t:1.25});assert(Object.is(s.info('room').values.z,-0));assert.equal((fields.snapshot().data[0] as {value:number}).value,1.25);assert.equal(factory.toJSON().templates,1);receiver.close();assert.equal(factory.toJSON().templates,0);assert.equal(factory.toJSON().closed,false);}
 finally{receiver.close();s.close();}
}));
test('shared sensor uses existing and later globals with real Node callables',()=>fixture(async factory=>{
 factory.addEnvironmentGlobal('gain',templateFloatValue(2.5));let calls=0;const {store:s}=store(),receiver=new SharedSensorMessages(s,'room',factory.createTemplate('{set_result("t",adjust(payload|float) * gain + offset)}'));
 factory.addEnvironmentGlobal('offset',2n);factory.addEnvironmentGlobal('adjust',call=>{calls++;assert.equal(call.kwargs.size,0);assert.deepEqual(call.args,[templateFloatValue(4)]);return templateFloatValue(5);});
 try{assert(receiver.receive(Buffer.from('4')));assert.equal(s.info('room').values.t,14.5);assert.equal(calls,1);assert.equal(factory.toJSON().asyncInitialized,false);}finally{receiver.close();s.close();}
}));
test('unused global bindings and macro aliases retain actual callable semantics',()=>fixture(async factory=>{
 for(let i=0;i<32;i++)factory.addEnvironmentGlobal('unused_'+i,()=>{assert.fail('Unused function must not run');});let calls=0;factory.addEnvironmentGlobal('calc',()=>{calls++;return 9n;});
 for(const source of ['{% set alias=calc %}{set_result("t",alias())}','{% macro value() %}{set_result("t",calc())}{% endmacro %}{value()}','{% for fn in [calc] %}{set_result("t",fn())}{% endfor %}']){const t=factory.createTemplate(source);try{assert.equal(t.renderSensor('')[0].numberValue,9);}finally{t.close();}}assert.equal(calls,3);
}));
test('late referenced callable registration invalidates the sensor fast path',()=>fixture(async factory=>{
 const t=factory.createTemplate('{% if payload == "first" %}{set_result("t",1)}{% else %}{set_result("t",later())}{% endif %}');
 try{assert.equal(t.renderSensor('first')[0].numberValue,1);factory.addEnvironmentGlobal('later',()=>8n);assert.equal(t.renderSensor('second')[0].numberValue,8);assert.equal(t.renderSensor('first')[0].numberValue,1);}finally{t.close();}
}));
test('keyword binding, duplicate parameters and per-frame set_result shadowing retain upstream setter semantics',()=>fixture(async factory=>{
 factory.addEnvironmentGlobal('set_result',()=>{assert.fail('Shared global must be shadowed');});const {store:s}=store(),receiver=new SharedSensorMessages(s,'room',factory.createTemplate('{set_result(value=1,name="t")}{set_result("t",value=2.675)}'));
 try{assert(receiver.receive(Buffer.from('')));assert.equal(s.info('room').values.t,2.675);}finally{receiver.close();s.close();}
 for(const source of ['{set_result("t",1,name="other")}','{set_result(name="t")}','{set_result("t",1,extra=2)}','{set_result("t",1,2)}']){const t=factory.createTemplate(source);try{assert.throws(()=>t.renderSensor(''));}finally{t.close();}}
}));
test('failure after a reading preserves prior frame and history without private diagnostics',()=>fixture(async factory=>{
 const {store:s,fields}=store(),receiver=new SharedSensorMessages(s,'room',factory.createTemplate('{set_result("t",payload|float)}{% if payload == "99" %}{raise_error(secrets["marker"])}{% endif %}'));
 try{assert(receiver.receive(Buffer.from('2.675')));assert.equal(receiver.receive(Buffer.from('99')),false);assert.equal(s.info('room').values.t,2.675);assert.equal((fields.snapshot().data[0] as {value:number}).value,2.675);for(const text of [JSON.stringify(s.status),inspect(factory),JSON.stringify(factory)])assert(!text.includes('synthetic-private'));assert(receiver.receive(Buffer.from('1')));assert.equal((fields.snapshot().data[0] as {value:number}).value,3.675);assert.deepEqual(s.status.errors,{});}finally{receiver.close();s.close();}
}));
test('raw sensor payload capacity is independent of JSON context escaping',()=>fixture(async factory=>{
 const {store:s}=store(),receiver=new SharedSensorMessages(s,'room',factory.createTemplate('{set_result("t",payload|length)}'));
 try{assert(receiver.receive(Buffer.from('"'.repeat(65536))));assert.equal(s.info('room').values.t,65536);assert.equal(receiver.receive(Buffer.alloc(65537)),false);assert.equal(receiver.receive(Buffer.from([0xff])),false);assert.equal(s.info('room').values.t,65536);}finally{receiver.close();s.close();}
}));
test('numeric, parameter, fuel and output bounds never publish a partial sensor frame',()=>fixture(async factory=>{
 for(const suffix of ['{set_result("bad",9007199254740992)}','{set_result("bad",1e999)}','{set_result("bad",none)}','{% for i in range(17) %}{set_result(i|string,i)}{% endfor %}','{% for i in range(1000000) %}{% set j=i %}{% endfor %}','{"x" * 65537}']){
  const {store:s}=store();s.update('room',{t:{value:7}});const receiver=new SharedSensorMessages(s,'room',factory.createTemplate('{set_result("t",9)}'+suffix));try{assert.equal(receiver.receive(Buffer.from('')),false);assert.equal(s.info('room').values.t,7);}finally{receiver.close();s.close();}
 }
}));
test('nested rendering has independent native collectors and no cross-frame values',()=>fixture(async factory=>{
 const nested=factory.createTemplate('{set_result("nested",payload|float)}');let seen:unknown;factory.addEnvironmentGlobal('nested',()=>{seen=nested.renderSensor('8');return 1n;});const outer=factory.createTemplate('{set_result("outer",nested())}');
 try{assert.deepEqual(outer.renderSensor(''),[{name:'outer',numberType:'integer',numberValue:1}]);assert.deepEqual(seen,[{name:'nested',numberType:'float',numberValue:8}]);}finally{outer.close();nested.close();}
}));
test('reentrant source and generation retirement fence publication during custom globals',()=>fixture(async factory=>{
 const {store:s}=store();s.update('room',{t:{value:7}});let receiver:SharedSensorMessages;factory.addEnvironmentGlobal('reenter',()=>{assert.equal(receiver.receive(Buffer.from('nested')),false);return 1n;});receiver=new SharedSensorMessages(s,'room',factory.createTemplate('{set_result("t",reenter())}'));
 try{assert.equal(receiver.receive(Buffer.from('')),false);assert.equal(s.info('room').values.t,7);}finally{receiver.close();s.close();}
 const next=store();factory.addEnvironmentGlobal('retire',()=>{factory.close();return 2n;});const retiring=new SharedSensorMessages(next.store,'room',factory.createTemplate('{set_result("t",retire())}'));
 try{assert.equal(retiring.receive(Buffer.from('')),false);assert.deepEqual(next.store.info('room').values,{});assert.equal(factory.toJSON().templates,0);}finally{retiring.close();next.store.close();}
}));
test('trusted logging and synchronous promises keep shared template policies',()=>{
 const logs:unknown[]=[];return fixture(async factory=>{const t=factory.createTemplate('{log_debug(msg="frame")}{set_result("t",1)}');try{assert.equal(t.renderSensor('')[0].numberValue,1);assert.equal(logs.length,1);assert.throws(()=>t.renderSensor('',{callables:new Map([['set_result',()=>null]])}));}finally{t.close();}
 factory.addEnvironmentGlobal('late',async()=>1n);const p=factory.createTemplate('{set_result("t",late())}');try{assert.throws(()=>p.renderSensor(''));}finally{p.close();}const async=factory.createTemplate('{set_result("t",1)}',true);try{assert.throws(()=>async.renderSensor(''),/synchronous/);}finally{async.close();}
 },{debug:call=>logs.push(call)});
});
test('automatic MQTT configuration consumes shared calibration and releases its sensor handle',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shared-sensor-mqtt-')),peer=await mqttPeer(),file=join(root,'moonraker.conf');let server:ConfiguredMoonraker|undefined;
 try{await writeFile(join(root,'moonraker.secrets'),'{"calibration":{"gain":"1.25"}}');await writeFile(file,`[server]\nhost: 127.0.0.1\nport: 0\n[mqtt]\naddress: 127.0.0.1\nport: ${peer.port}\n[sensor room]\ntype: MQTT\nstate_topic: room\nstate_response_template: {set_result("t",payload|float * (secrets["calibration"]["gain"]|float) + offset)}\n`);
 server=await ConfiguredMoonraker.load(file,{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:()=>{},templates:{dataPath:root}});server.templates!.addEnvironmentGlobal('offset',2n);const owner=server.templates!;await writeFile(join(root,'moonraker.secrets'),'{"calibration":{"gain":"99"}}');const address=await server.start();peer.publish('room','4');const deadline=performance.now()+3000;while(!server.sensorTransportStatus?.messages){assert(performance.now()<deadline);await new Promise(r=>setTimeout(r,5));}const body=await(await fetch(`http://127.0.0.1:${address.port}/server/sensors/info?sensor=room`)).json() as any;assert.equal(body.result.values.t,7);assert.equal(owner.toJSON().templates,1);await server.close();assert.equal(owner.toJSON().templates,0);assert.equal(owner.toJSON().closed,true);
 }finally{await server?.close();await peer.close();await rm(root,{recursive:true,force:true});}
});
test('unbound explicit generation retains native adapter and compilation failure releases shared handles',()=>fixture(async(factory,root)=>{
 const reader=new ConfigurationReader(new ConfigurationSource(join(root,'plain.conf'),{DEFAULT:{},server:{},mqtt:{address:'127.0.0.1'},'sensor room':{type:'MQTT',state_topic:'room',state_response_template:'{set_result("t",payload|float)}'}},[]));const old=await configureNativeSensorsFromConfig(reader,()=>false);try{assert(old.receivers[0] instanceof NativeSensorMessages);}finally{await old.close();}
 const bad=new ConfigurationReader(new ConfigurationSource(join(root,'bad.conf'),{DEFAULT:{},server:{},mqtt:{address:'127.0.0.1'},'sensor room':{type:'MQTT',state_topic:'room',state_response_template:'{set_result("t",1)}'},'sensor invalid':{type:'MQTT',state_topic:'invalid',state_response_template:'{% if %}'}},[])),release=bad.bindTemplates(factory);
 try{await assert.rejects(configureNativeSensorsFromConfig(bad,()=>false));assert.equal(factory.toJSON().templates,0);}finally{release();}
}));
