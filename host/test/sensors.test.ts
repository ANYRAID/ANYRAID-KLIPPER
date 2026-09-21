import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {SensorStore,registerSensors,type SensorOptions,type SensorReading} from '../src/moonraker/sensors.ts';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,ApiError,type RpcContext} from '../src/moonraker/rpc.ts';
import {sensorOracle} from './helpers/sensor-oracle.ts';
test('sensor frames, sampling, disconnect and history bindings match pinned upstream',()=>{
 const definition:SensorOptions={id:'room',type:'MQTT',name:'Room',capacity:3,parameters:[{name:'t',units:'C'}],history:[{parameter:'t',name:'average',description:'Temperature',strategy:'average',precision:2,excludePaused:true,reportTotal:true},{parameter:'e',name:'energy',description:'Energy',strategy:'delta',initTracker:true,reportTotal:true},{parameter:'t',name:'peak',description:'Peak',strategy:'maximum',reportMaximum:true}]};
 type Op={kind:'frame';values:Record<string,SensorReading>}|{kind:'sample'|'start'|'disconnect'}|{kind:'pause';paused:boolean};
 const ops:Op[]=[{kind:'frame',values:{t:{value:20,numberType:'integer'},e:{value:100,numberType:'integer'}}},{kind:'sample'},{kind:'start'}];
 for(let i=0;i<12;i++){ops.push({kind:'frame',values:{t:{value:20+i/8},e:{value:101+i,numberType:'integer'}}},{kind:'sample'});if(i===3)ops.push({kind:'pause',paused:true});if(i===6)ops.push({kind:'pause',paused:false});}
 ops.push({kind:'frame',values:{t:{value:false}}},{kind:'sample'},{kind:'frame',values:{t:{value:0}}},{kind:'sample'},{kind:'disconnect'},{kind:'sample'},{kind:'sample'},{kind:'start'},{kind:'frame',values:{e:{value:1,numberType:'integer'}}},{kind:'sample'});
 const child=spawnSync('python3',['-c',sensorOracle()+'\nprint(json.dumps(run_sensor(json.load(sys.stdin))))'],{input:JSON.stringify({definition,ops}),encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout);
 let active=false,paused=false;const fields=new HistoryFields(exclude=>active&&!(exclude&&paused)),store=new SensorStore(),events:unknown[]=[];store.register(definition,fields);
 const actual=ops.map(op=>{switch(op.kind){case 'frame':store.update('room',op.values);break;case 'sample':{const changed=store.sample();if(Object.keys(changed).length)events.push(changed);break;}case 'start':fields.reset();active=true;paused=false;break;case 'pause':paused=op.paused;break;case 'disconnect':store.disconnect('room');break;}return structuredClone({info:store.info('room',true),measurements:store.measurements(),history:fields.snapshot().data,events});});
 assert.deepEqual(actual,expected);
});
test('failed sensor frame rolls back collection, delta baseline and all numeric accumulators',()=>{
 const fields=new HistoryFields(()=>true),store=new SensorStore();store.register({id:'meter',type:'MQTT',capacity:2,history:[{parameter:'a',name:'values',description:'Values',strategy:'collect'},{parameter:'a',name:'delta',description:'Delta',strategy:'delta',initTracker:true},{parameter:'b',name:'sum',description:'Sum',strategy:'accumulate'}]},fields);fields.reset();
 store.update('meter',{a:{value:10},b:{value:1e308}});const before=fields.snapshot();assert.throws(()=>store.update('meter',{a:{value:20},b:{value:1e308}}),/overflow/);assert.deepEqual(fields.snapshot(),before);assert.deepEqual(store.info('meter').values,{a:10,b:1e308});
 store.update('meter',{a:{value:25},b:{value:-1e308}});assert.deepEqual(fields.snapshot().data.map((v:any)=>v.value),[[10,25],25,0]);assert.deepEqual(store.status.errors,{});
});
test('registration failures preserve registry ownership and bounded storage',()=>{
 const fields=new HistoryFields(()=>true),store=new SensorStore({maxSlots:8});
 assert.throws(()=>store.register({id:'bad',type:'MQTT',capacity:1,maxParameters:2,history:[{parameter:'x',name:'ok',description:'OK',strategy:'basic'},{parameter:'y',name:'bad',description:'bad',strategy:'missing'}]},fields));assert.deepEqual(fields.configuration,[]);assert.deepEqual(store.list(),{sensors:{}});assert.equal(store.status.reservedSlots,0);
 store.register({id:'valid',type:'MQTT',capacity:2,maxParameters:2});assert.throws(()=>store.register({id:'large',type:'MQTT',capacity:3,maxParameters:2}),/capacity/);
 store.update('valid',{a:{value:1},b:{value:2}});store.sample();assert.throws(()=>store.update('valid',{c:{value:3}}),/capacity/);assert.deepEqual(store.info('valid').values,{a:1,b:2});
 assert.throws(()=>store.update('valid',{a:{value:1e20,numberType:'integer'}}),/unsafe/);store.close();assert.throws(()=>store.sample(),/closed/);assert.throws(()=>store.update('valid',{}),/closed/);
});
test('zero-capacity stores and special keys preserve numeric values and API contracts',async()=>{
 const store=new SensorStore();store.register({id:'__proto__',type:'MQTT',capacity:0});store.update('__proto__',Object.fromEntries([['__proto__',{value:2.675}]]));assert.deepEqual(store.measurements(),Object.fromEntries([['__proto__',{}]]));store.sample();assert.deepEqual(store.measurements(),Object.fromEntries([['__proto__',Object.fromEntries([['__proto__',[]]])]]));
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),release=registerSensors(registry,store),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 try{assert.deepEqual(await registry.invoke('/server/sensors/list','GET',{extended:'TRUE'},context),store.list(true));assert.deepEqual(await registry.invoke('/server/sensors/info','GET',{sensor:'__proto__'},context),store.info('__proto__'));assert.deepEqual(await registry.invoke('/server/sensors/measurements','GET',{sensor:''},context),store.measurements());await assert.rejects(registry.invoke('/server/sensors/info','GET',{sensor:'missing'},context),e=>e instanceof ApiError&&e.status===500);await assert.rejects(registry.invoke('/server/sensors/list','GET',{extended:1},context),e=>e instanceof ApiError&&e.status===400);}finally{release();}
 await assert.rejects(registry.invoke('/server/sensors/list','GET',{},context),e=>e instanceof ApiError&&e.status===404);
});
