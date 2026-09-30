import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {SerialSession} from '../protocol/serial-session.ts';
import {configuredMCUConnections,type MCUMachinePolicy} from './configured-mcu-connections.ts';

/** Old motion, peripherals and transport owners must already be retired. Each
 * connection here is diagnostic only; no configuration or motion is sent.
 * Preflight every dictionary before any reset, then reconnect and prove cleared
 * state. ACK alone never grants readiness. Cleanup uncertainty is aggregated. */
export async function resetConfiguredFirmware(reader:ConfigurationReader,policies:ReadonlyMap<string,MCUMachinePolicy>,signal:AbortSignal){
 signal.throwIfAborted();
 const saved=new Map([...policies].map(([id,p])=>[id,p.transport==='uart'?{...p,leaveBootloader:false}:p]));
 const entries=configuredMCUConnections(reader,saved),sessions=new Map<string,SerialSession>(),safety=new Set<Promise<void>>();
 const deadline=AbortSignal.any([signal,AbortSignal.timeout(15000)]),result:{id:string;acknowledged:boolean;restartObserved:boolean}[]=[];
 let failure:unknown;
 const connect=async(entry:typeof entries[number])=>{
  let stopped:Promise<void>|undefined;
  const stop=(cause:unknown)=>{if(!stopped){stopped=Promise.resolve().then(()=>entry.stopDevice(cause));safety.add(stopped);void stopped.catch(()=>{});}return stopped;};
  const session=await entry.connect(deadline,stop);sessions.set(entry.id,session);deadline.throwIfAborted();session.assertActive();return session;
 };
 try{
  // New adapter must confirm independent safety before diagnostic acquisition.
  const stops=await Promise.allSettled(entries.map(entry=>entry.stopDevice(new Error('Firmware restart diagnostic admission'))));
  const unsafe=stops.filter(r=>r.status==='rejected').map(r=>r.reason);if(unsafe.length)throw new AggregateError(unsafe,'Firmware restart physical stop unconfirmed');
  deadline.throwIfAborted();const opened=await Promise.allSettled(entries.map(connect));
  const rejected=opened.find(r=>r.status==='rejected');if(rejected)throw rejected.reason;
  if(new Set(sessions.values()).size!==entries.length)throw new Error('Firmware restart requires distinct exclusive sessions');
  for(const session of sessions.values()){session.assertActive();session.dictionary.lookup('reset');}
  for(const entry of entries){deadline.throwIfAborted();result.push({id:entry.id,...await sessions.get(entry.id)!.resetOffline(deadline)});}
  // Release each old diagnostic owner before acquiring its verification owner.
  for(const session of sessions.values())await session.stop();sessions.clear();
  for(const entry of entries){
   const session=await connect(entry),response=await session.query(session.dictionary.encode('get_config',{}),'config',deadline,{retries:5});
   const p=response.message.parameters;
   if(response.message.name!=='config'||p.is_config!==0||p.crc!==0||p.is_shutdown!==0)throw new Error('Firmware reset did not clear MCU configuration and shutdown');
  }
  deadline.throwIfAborted();
 }catch(error){failure=error;}
 const cleanup=await Promise.allSettled([...sessions.values()].map(session=>session.stop(new Error('Firmware restart diagnostic retirement'))));
 const stops=await Promise.allSettled([...safety]),errors=[...cleanup,...stops].filter(r=>r.status==='rejected').map(r=>r.reason);
 if(errors.length)throw new AggregateError([failure,...new Set(errors)].filter(e=>e!==undefined),'Firmware restart and diagnostic cleanup failed',{cause:failure});
 if(failure!==undefined)throw failure;return result;
}
