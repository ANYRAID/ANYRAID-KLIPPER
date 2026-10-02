import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {SensorMessages,type SensorTemplateContext} from '../src/moonraker/sensor-messages.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {sensorOracle} from './helpers/sensor-oracle.ts';
const make=()=>{const store=new SensorStore();store.register({id:'room',type:'MQTT'});store.update('room',{t:{value:20}});return store;};
test('decoded message numeric conversion matches pinned Python setter including BOM and signed zero',()=>{
 const inputs=['2.675',' ١_٢.５e-１ ','-0',true,false,12];
 const child=spawnSync('python3',['-c',sensorOracle()+`\nvalues=json.loads(${JSON.stringify(JSON.stringify(inputs))})\nresult={}\nfor i,v in enumerate(values):_set_result(str(i),v,result)\nprint(json.dumps(result))`],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);
 const store=make(),source=new SensorMessages(store,'room',context=>{assert.equal(context.payload,'\ufeffpayload');inputs.forEach((v,i)=>context.setResult(String(i),v));});
 assert.equal(source.receive(Buffer.from('\ufeffpayload')),true);assert.deepEqual(store.info('room').values,JSON.parse(child.stdout));assert.equal(Object.is(store.info('room').values['2'],-0),true);
});
test('invalid bytes, conversion, rendering and payload capacity preserve prior frame and clear diagnostics on success',()=>{
 const store=make();let mode='valid';const source=new SensorMessages(store,'room',context=>{context.setResult('t',30);if(mode==='throw')throw new Error('render failed');if(mode==='invalid')context.setResult('x','0x10');if(mode==='infinity')context.setResult('x',Infinity);if(mode==='unsafe')context.setResult('x',Number.MAX_SAFE_INTEGER+1,'integer');if(mode==='many'){context.setResult('x',1);context.setResult('y',1);}}, {maxBytes:8,maxParameters:2});
 for(const payload of [Buffer.from([0xff]),Buffer.alloc(9)]){assert.equal(source.receive(payload),false);assert.deepEqual(store.info('room').values,{t:20});}
 for(mode of ['throw','invalid','infinity','unsafe','many']){assert.equal(source.receive(Buffer.from('ok')),false);assert.deepEqual(store.info('room').values,{t:20});assert.ok(store.status.errors.room);}
 mode='valid';assert.equal(source.receive(Buffer.from('ok')),true);assert.deepEqual(store.status.errors,{});assert.deepEqual(store.info('room').values,{t:30});
});
test('late and asynchronous render callbacks cannot publish or retain a frame',async()=>{
 const store=make();let retained:SensorTemplateContext|undefined;const source=new SensorMessages(store,'room',context=>{retained=context;context.setResult('t',21);});assert.equal(source.receive(Buffer.from('ok')),true);assert.throws(()=>retained!.setResult('t',99),/no longer active/);
 const asyncSource=new SensorMessages(store,'room',async context=>{await Promise.resolve();context.setResult('t',99);});assert.equal(asyncSource.receive(Buffer.from('ok')),false);await new Promise(r=>setImmediate(r));assert.deepEqual(store.info('room').values,{t:21});source.close();assert.equal(source.receive(Buffer.from('ok')),false);source.disconnect();assert.deepEqual(store.info('room').values,{t:21});store.close();assert.equal(asyncSource.receive(Buffer.from('ok')),false);
});
test('disconnect, close and reentrancy during rendering fence the outer frame',()=>{
 for(const mode of ['disconnect','close','reenter']){const store=make();let source:SensorMessages;source=new SensorMessages(store,'room',context=>{context.setResult('t',99);if(mode==='disconnect')source.disconnect();else if(mode==='close')source.close();else assert.equal(source.receive(Buffer.from('nested')),false);});assert.equal(source.receive(Buffer.from('ok')),false);assert.deepEqual(store.info('room').values,mode==='disconnect'?{}:{t:20});}
 const store=make(),source=new SensorMessages(store,'room',context=>{context.setResult('__proto__',1);context.setResult('__proto__',2);},{maxParameters:1});assert.equal(source.receive(Buffer.from('ok')),true);assert.deepEqual(store.info('room').values,Object.fromEntries([['__proto__',2]]));source.disconnect();assert.deepEqual(store.info('room').values,{});
});
