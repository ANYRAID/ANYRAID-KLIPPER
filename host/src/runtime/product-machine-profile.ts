import {open,constants} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {parseProductMachine,type ProductMachineConfiguration} from '../config/product-machine.ts';
import {planLinearPrinter} from '../config/linear-printer.ts';
import {loadConfiguration} from '../moonraker/config-source.ts';
import {KlipperSaveSession} from '../config/klipper-save-session.ts';
import {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readNetworkBinding} from '../moonraker/configured-server.ts';
import {ServerInformation} from '../moonraker/metadata.ts';
import {PrintJournal} from '../operations/print-journal.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {planMCUConnections,type MCUMachinePolicy} from './configured-mcu-connections.ts';
import type {ProductHostProfile} from './product-host.ts';
export interface ProductMachineBindings {
 stops:ReadonlyMap<string,MCUMachinePolicy['stopDevice']>;
 print:Pick<ProductHostProfile['options']['print'],'lifecycle'|'open'|'output'>;
 server:ProductHostProfile['options']['server'];
 /** Close every resource acquired by the bindings factory. Called once after
  * host retirement, or if profile assembly fails after the factory returns. */
 release():Promise<void>;
}
export type ProductMachineBindingsFactory=(configuration:ProductMachineConfiguration,signal:AbortSignal,maintenanceGate:MaintenanceGate)=>Promise<ProductMachineBindings>;
/** Bounded local data file. Opening a FIFO/device must never hang startup. */
export async function readProductMachine(path:string,signal:AbortSignal):Promise<ProductMachineConfiguration>{
 signal.throwIfAborted();if(typeof path!=='string'||!isAbsolute(path)||/[\0\r\n]/u.test(path))throw new TypeError('Machine configuration requires an absolute path');
 const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>65536)throw new Error('Machine configuration must be a regular file of at most 65536 bytes');const bytes=Buffer.alloc(65537);let length=0;while(length<bytes.length){signal.throwIfAborted();const {bytesRead}=await file.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}signal.throwIfAborted();if(length>65536)throw new Error('Machine configuration exceeds 65536 bytes');return parseProductMachine(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length))));}finally{await file.close();}
}
/** Shared read-only configuration and topology preflight. Does not acquire
 * adapters, journals, transports, or validate MCU-dictionary-dependent options. */
export async function preflightProductMachine(path:string,signal:AbortSignal){
 signal.throwIfAborted();
 const config=await readProductMachine(path,signal);
 const configuration=await KlipperSaveSession.load(config.printerConfig,{signal});
 const reader=new ConfigurationReader(configuration.source,null);signal.throwIfAborted();
 const moonraker=new ConfigurationReader(await loadConfiguration(config.moonrakerConfig));readNetworkBinding(moonraker);signal.throwIfAborted();
 // Validate topology and transport declarations before acquiring adapter resources.
 const provisional=new Map(Object.entries(config.mcus));
 const connections=planMCUConnections(reader,provisional),plan=planLinearPrinter(reader,{...config.machine,mcus:[...provisional.keys()]});
 return {config,configuration,reader,provisional,connections,plan};
}
/** Adapter factory owns partial acquisition; successful return transfers its
 * resources even when cancellation raced with the return. */
export async function loadProductMachineProfile(path:string,createBindings:ProductMachineBindingsFactory,signal:AbortSignal):Promise<ProductHostProfile>{
 signal.throwIfAborted();if(typeof createBindings!=='function')throw new TypeError('Machine bindings factory is required');
 const {config,configuration,reader,provisional}=await preflightProductMachine(path,signal);
 let bindings:ProductMachineBindings|undefined,journal:PrintJournal|undefined,closing:Promise<void>|undefined;const gate=new MaintenanceGate();
 const release=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;gate.invalidate();
  void (async()=>{const errors:unknown[]=[];if(bindings&&typeof bindings.release==='function')try{await bindings.release();}catch(error){errors.push(error);}if(journal)try{await journal.close();}catch(error){errors.push(error);}if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Machine profile cleanup failed');})().then(done.resolve,done.reject);return closing;
 };
 try{
  bindings=await createBindings(structuredClone(config),signal,gate);signal.throwIfAborted();
  if(!bindings||typeof bindings.release!=='function'||!bindings.stops||bindings.stops.size!==provisional.size||typeof bindings.server?.authorize!=='function'||typeof bindings.print?.open!=='function'||typeof bindings.print?.output!=='function')throw new TypeError('Incomplete machine bindings');
  for(const key of ['prepare','start','finishOutputs','stopOutputs'] as const)if(typeof bindings.print.lifecycle?.[key]!=='function')throw new TypeError('Incomplete machine lifecycle');
  new ServerInformation(bindings.server.information);
  const policies=new Map<string,MCUMachinePolicy>();for(const [id,p] of Object.entries(config.mcus)){const stopDevice=bindings.stops.get(id);if(typeof stopDevice!=='function')throw new TypeError('Missing physical stop binding: '+id);policies.set(id,{...p,stopDevice} as MCUMachinePolicy);}
  journal=await PrintJournal.open({path:config.journalPath,deviceId:config.deviceId});signal.throwIfAborted();
  return {recoveryJournal:{path:config.journalPath+'.host-recovery.sqlite',deviceId:config.deviceId},reader,policies,product:{journal,configurationSession:configuration.session,maintenanceGate:gate,limits:{...config.limits},deadlines:{...config.deadlines}},options:{configPath:config.moonrakerConfig,machine:{...config.machine},hardware:config.hardware,print:{...config.print,open:bindings.print.open,output:bindings.print.output,lifecycle:{...bindings.print.lifecycle}},server:{...bindings.server}},release};
 }catch(error){try{await release();}catch(cleanup){throw new AggregateError([error,cleanup],'Machine profile assembly and cleanup failed',{cause:error});}throw error;}
}
