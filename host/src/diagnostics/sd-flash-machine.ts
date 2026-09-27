import type {MessageDictionary} from '../protocol/dictionary.ts';
import type {SerialSession} from '../protocol/serial-session.ts';
import {PrinterPins} from '../protocol/pins.ts';
import {compileSpi,compileSoftwareSpi} from '../protocol/spi-config.ts';
import {spiBusRequests} from '../config/spi-bus.ts';
import {compileSDIO,sessionSDIO} from './sdio-mcu.ts';
import {SDCardSDIO} from './sd-card-sdio.ts';
import {sessionSDCardSPI} from './sd-card-mcu.ts';
import {planSDFlash} from './sd-boards.ts';
import {SDFileSystem} from './sd-filesystem.ts';
/** Full offline resource preflight before any configuration writes. */
export function compileSDFlashBoard<T>(chip:T,dictionary:MessageDictionary,board:string,fast=false){
 const actual=dictionary.constant('MCU');if(typeof actual!=='string')throw new Error('Invalid firmware MCU identity');const plan=planSDFlash(board,actual,fast),pins=new PrinterPins<T>();pins.register('mcu',chip);
 const reserved:number[]=[];for(const [name,value] of Object.entries(dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid reserved pin metadata');for(const pin of value.split(',').map(p=>p.trim()).filter(Boolean)){const id=dictionary.pinEnumeration[pin];if(id!==undefined)reserved.push(id);}}
 const mapping=new Map([['mcu',{pins:dictionary.pinEnumeration,reserved}]]);let commands:string[];
 if(plan.bus.kind==='sdio'){
  const config=compileSDIO(dictionary,0,plan.bus.bus),metadata=dictionary.constant('BUS_PINS_'+plan.bus.bus);if(typeof metadata!=='string')throw new Error('Missing SDIO pin metadata');const names=metadata.split(',').map(p=>p.trim());
  if(names.length<3||names.length>6)throw new Error('Invalid SDIO pin metadata');pins.lookupBatch(names.map(description=>({description,exclusive:true})),mapping);commands=[config.config,config.configureBus];
 }else{
  const cs=pins.parse(plan.bus.chipSelect),software=plan.bus.kind==='software-spi'?plan.bus.pins.map(name=>pins.parse(name)):undefined;
  const busPins=spiBusRequests(pins,'mcu',dictionary,plan.bus.kind==='spi'?plan.bus.bus:'swspi',software);
  pins.lookupBatch([{description:plan.bus.chipSelect,exclusive:true},...busPins.map(p=>({description:p.description,exclusive:true}))],mapping);
  const config=software?compileSoftwareSpi(chip,dictionary,0,cs,software,plan.bus.rate,0):compileSpi(chip,dictionary,0,cs,plan.bus.kind==='spi'?plan.bus.bus:'',plan.bus.rate,0);commands=[config.select,config.configureBus];
 }
 return {plan,configuration:{oidCount:1,commands,firmwareRestart:true as const}};
}
const owners=new WeakSet<SerialSession>();
/** Takes ownership of an initialized, exclusively opened offline MCU session.
 * A configured MCU is rejected; this function never resets an active printer. */
export async function openSDFlashMachine(session:SerialSession,board:string,signal:AbortSignal,options:{fast?:boolean;helper?:string}={}){
 signal.throwIfAborted();session.assertActive();if(owners.has(session)||session.status.configured)throw new Error('SD flashing requires a fresh exclusive MCU session');
 const compiled=compileSDFlashBoard(session,session.dictionary,board,options.fast??false);owners.add(session);let files:SDFileSystem|undefined,closing:Promise<void>|undefined;
 const close=()=>closing??=(async()=>{const errors:unknown[]=[];try{await files?.close();}catch(error){errors.push(error);}try{await session.stop();}catch(error){errors.push(error);}finally{owners.delete(session);}if(errors.length)throw new AggregateError(errors,'SD flash machine cleanup failed');})();
 try{
  await session.configure(compiled.configuration,signal);signal.throwIfAborted();
  const card=compiled.plan.bus.kind==='sdio'?new SDCardSDIO(sessionSDIO(session,0)):sessionSDCardSPI(session,0);
  files=await SDFileSystem.open(card,signal,options.helper);signal.throwIfAborted();return {plan:compiled.plan,files,close};
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'SD flash machine startup and cleanup failed',{cause:error});}throw error;}
}
