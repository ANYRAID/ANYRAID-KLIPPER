import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {configuredPrinterFixture} from './configured-printer.ts';
import {productTransports} from './product-transports.ts';
import {PrintJournal} from '../../src/operations/print-journal.ts';
import {MaintenanceGate} from '../../src/operations/maintenance-gate.ts';
import {ApiError} from '../../src/moonraker/rpc.ts';
import type {ProductHostProfile} from '../../src/runtime/product-host.ts';
/** Test-only machine profile: two PTYs and emulated physical stops. */
export async function productHostFixture(dir:string){
 const f=await configuredPrinterFixture(false,false),transport=await productTransports(f.reader),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'printer'}),configPath=join(dir,'moonraker.conf');
 await writeFile(configPath,'[server]\nhost=127.0.0.1\nport=0');let released=false;
 const profile:ProductHostProfile={reader:transport.reader,policies:transport.policies,product:{journal,maintenanceGate:new MaintenanceGate(),limits:{maxNozzle:300,maxBed:130}},options:{configPath,machine:{enableLeadTime:.001,fanMinimumScheduleTime:.001},hardware:f.options.hardware,print:f.options.print,server:{information:{connected:false,state:'disconnected',components:[],failedComponents:[],directories:[],warnings:[],version:'test',missingRequirements:[]},authorize:(_method,_params,context)=>{if(context.request.headers['x-api-key']!=='test')throw new ApiError(401,'Denied');return {username:'operator'};}}},async release(){
  if(released)return;released=true;
  await transport.close();await f.close();await journal.close();await writeFile(join(dir,'closed.json'),JSON.stringify({stops:transport.stops,motion:transport.firmware.map(f=>f.motion.length)}));
 }};
 return {profile,transport,f,journal,get released(){return released;}};
}
export async function createProductHostProfile(signal:AbortSignal):Promise<ProductHostProfile>{
 signal.throwIfAborted();const dir=process.env.ANYRAID_TEST_PROFILE_DIR;if(!dir)throw new Error('Test profile requires its fixture directory');
 return (await productHostFixture(dir)).profile;
}
