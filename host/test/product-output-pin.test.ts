import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {connectProductPrinter} from '../src/runtime/product-printer.ts';
import {productObjects} from '../src/runtime/product-objects.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {registerNativeObjects} from '../src/moonraker/native-objects.ts';
test('product object endpoint reports normalized output values after native SET_PIN',async()=>{
 const f=await configuredPrinterFixture(false,false),dir=await mkdtemp(join(tmpdir(),'output-pin-product-'));
 const journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'test'});
 let printer:Awaited<ReturnType<typeof connectProductPrinter>>|undefined;
 try{
  const reader=new ConfigurationReader(new ConfigurationSource('/pin.cfg',{...f.reader.source.original,'output_pin duty':{pin:'aux:PA13',pwm:'true',hardware_pwm:'true',scale:'255'}},[]),null);
  const plan=planLinearPrinter(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  printer=await connectProductPrinter(reader,f.connections,'mcu',plan.layout,{...f.options,motion:plan.initial},{journal,maintenanceGate:new MaintenanceGate(),limits:{maxNozzle:300,maxBed:130}},f.signal);
  const objects=productObjects(printer,()=>{throw new Error('Unrequested host state');});
  const registry=new EndpointRegistry(new JsonRpcDispatcher());registerNativeObjects(registry,objects);
  const query=()=>registry.invoke('/printer/objects/query','POST',{objects:{'output_pin duty':['value']}},{transport:'http',signal:f.signal,authorize(){}}) as Promise<{status:Record<string,{value:number}>}>;
  assert.ok(objects.list().objects.includes('output_pin duty'));assert.equal((await query()).status['output_pin duty'].value,0);
  printer.print.gcode.enable();await printer.print.gcode.dispatch.execute('SET_PIN PIN=duty VALUE=127.5');
  assert.equal((await query()).status['output_pin duty'].value,.5);
 }finally{await printer?.close();await f.close();await journal.close();await rm(dir,{recursive:true,force:true});}
});
