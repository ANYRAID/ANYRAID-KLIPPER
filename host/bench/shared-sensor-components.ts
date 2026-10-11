import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {NativeSensorMessages,SharedSensorMessages} from '../src/moonraker/native-sensor-config.ts';
import {SensorStore} from '../src/moonraker/sensors.ts';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {MoonrakerTemplateFactory} from '../src/moonraker/template-factory.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {NativeHistoryFields} from '../src/moonraker/native-history-fields.ts';
import {PrintController} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
const referenceBytes=await readFile(new URL('../contracts/shared-sensor-components-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(referenceBytes).digest('hex'),'93bdc552c46f49a5b436e1422aae6df5318bba2a27293cbc08ca34387847786c');
const reference=JSON.parse(referenceBytes.toString());
const unused=Number(process.argv.find(arg=>arg.startsWith('--unused-globals='))?.split('=')[1]??0);assert(Number.isSafeInteger(unused)&&unused>=0&&unused<=64);
const times:number[]=[],bytes=Buffer.from(reference.payload),root=await mkdtemp(join(tmpdir(),'shared-sensor-components-'));
const nativeGate=process.argv.includes('--native-print-gate');assert(!nativeGate||!process.argv.includes('--capture'));
try{await writeFile(join(root,'moonraker.secrets'),'{}');
 for(let run=0;run<9;run++){
  const native=nativeGate?new NativeHistoryFields():undefined,fields=native?.fields??new HistoryFields(()=>true),store=new SensorStore();store.register({id:'room',type:'MQTT',history:[{name:'power',parameter:'power',description:'Reading',strategy:'average'}]},fields);
  const journal=native?await PrintJournal.open({path:join(root,run+'.db'),deviceId:'budget'}):undefined;
  const controller=journal?new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal}):undefined;
  if(controller){native!.bind(controller);await controller.start({version:1,requestId:'budget',fileId:'file',nozzle:0,bed:0});}
  const factory=await MoonrakerTemplateFactory.load(new ConfigurationReader(new ConfigurationSource(join(root,'moonraker.conf'),{DEFAULT:{},server:{}},[])),{dataPath:root});
  for(let i=0;i<unused;i++)factory.addEnvironmentGlobal('unused_'+i,()=>1n);
  const receiver=process.argv.includes('--capture')?new NativeSensorMessages(store,'room',reference.template):new SharedSensorMessages(store,'room',factory.createTemplate(reference.template));
  try{const begin=performance.now();for(let i=0;i<reference.frames;i++)receiver.receive(bytes);if(run>=reference.warmup)times.push(performance.now()-begin);assert.equal(receiver.status.accepted,reference.frames);assert.deepEqual(store.info('room').values,{power:25.5,voltage:230,current:0.125,energy:0.0012});assert.equal((fields.snapshot().data[0] as {value:number}).value,25.5);}
  finally{receiver.close();store.close();factory.close();try{await controller?.retire();}finally{await journal?.close();}}
 }
 const median=times.toSorted((a,b)=>a-b)[3],ratio=median/reference.median;console.log(JSON.stringify({node:process.version,frames:reference.frames,warmup:reference.warmup,samples:times,median,ratio,limit:reference.limit,passed:ratio<=reference.limit,unusedGlobals:unused,nativePrintGate:nativeGate,scope:reference.scope},null,2));assert(process.argv.includes('--capture')||ratio<=reference.limit,'Shared sensor ingress exceeds frozen native baseline');
}finally{await rm(root,{recursive:true,force:true});}
