import {isAbsolute} from 'node:path';
import type {MCUStartupPolicy} from '../runtime/configured-mcu-connections.ts';
import type {ConfiguredProductServiceOptions} from '../runtime/product-service.ts';
import type {ProductPrinterOptions} from '../runtime/product-printer.ts';
export interface ProductMachineConfiguration {
 version:1;deviceId:string;printerConfig:string;moonrakerConfig:string;journalPath:string;
 mcus:Record<string,MCUStartupPolicy>;
 machine:ConfiguredProductServiceOptions['machine'];
 print:Pick<ConfiguredProductServiceOptions['print'],'motorCompletion'|'startupHoming'|'parking'|'bedHeater'|'homingTimeoutMs'>;
 limits:ProductPrinterOptions['limits'];
 deadlines?:ProductPrinterOptions['deadlines'];
 hardware?:Pick<NonNullable<ConfiguredProductServiceOptions['hardware']>,'timeoutMs'|'heaterGcodeIds'>;
}
const fail=(path:string):never=>{throw new TypeError('Invalid product machine configuration: '+path);};
function object(value:unknown,path:string,required:readonly string[],optional:readonly string[]=[]):Record<string,any>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))return fail(path);
 const v=value as Record<string,unknown>;if(required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>!required.includes(k)&&!optional.includes(k)))fail(path);return v;
}
const number=(v:unknown,p:string,min:number,max=Number.MAX_VALUE,integer=false)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<min||v>max||integer&&!Number.isSafeInteger(v))fail(p);};
const name=(v:unknown,p:string)=>{if(typeof v!=='string'||!v.length||v.length>128||!v.isWellFormed()||/[\0\r\n]/u.test(v))fail(p);};
/** Strict versioned data only. Unknown options fail instead of silently changing
 * machine policy. Returns a detached tree; callers do not retain input aliases. */
export function parseProductMachine(value:unknown):ProductMachineConfiguration{
 const v=object(value,'root',['version','deviceId','printerConfig','moonrakerConfig','journalPath','mcus','machine','print','limits'],['deadlines','hardware']);
 if(v.version!==1||typeof v.deviceId!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(v.deviceId))fail('version/deviceId');
 for(const key of ['printerConfig','moonrakerConfig','journalPath'])if(typeof v[key]!=='string'||!isAbsolute(v[key])||!v[key].isWellFormed()||/[\0\r\n]/u.test(v[key])||Buffer.byteLength(v[key])>4096)fail(key);
 const ids=v.mcus&&typeof v.mcus==='object'?Object.keys(v.mcus):[];object(v.mcus,'mcus',ids);if(!ids.length||ids.length>16)fail('mcus');
 for(const id of ids){name(id,'mcus.id');const p=v.mcus[id];if(p?.transport==='uart'){object(p,'mcus.'+id,['transport','rts','leaveBootloader']);if(typeof p.rts!=='boolean'||typeof p.leaveBootloader!=='boolean')fail('mcus.'+id);}else if(p?.transport==='can'){object(p,'mcus.'+id,['transport','nodeId','timeoutMs']);number(p.nodeId,'nodeId',0,255,true);number(p.timeoutMs,'timeoutMs',1,60000,true);}else if(p?.transport==='pipe')object(p,'mcus.'+id,['transport']);else fail('mcus.'+id);}
 object(v.machine,'machine',['enableLeadTime','fanMinimumScheduleTime']);for(const key of Object.keys(v.machine))number(v.machine[key],'machine.'+key,Number.MIN_VALUE);
 object(v.limits,'limits',['maxNozzle','maxBed']);for(const key of Object.keys(v.limits))number(v.limits[key],'limits.'+key,Number.MIN_VALUE);
 const p=object(v.print,'print',['motorCompletion','startupHoming','parking'],['bedHeater','homingTimeoutMs']);if(!['hold','release'].includes(p.motorCompletion))fail('print.motorCompletion');
 const h=object(p.startupHoming,'print.startupHoming',['mode','axes']);if(!['home','require_homed'].includes(h.mode)||!Array.isArray(h.axes)||!h.axes.length||h.axes.length>3||new Set(h.axes).size!==h.axes.length)fail('print.startupHoming');for(const axis of h.axes)number(axis,'homing axis',0,2,true);
 const parking=object(p.parking,'print.parking',['parkXY','retract','lift','travelSpeed','liftSpeed','retractSpeed']);if(!Array.isArray(parking.parkXY)||parking.parkXY.length!==2)fail('parkXY');for(const n of parking.parkXY)number(n,'parkXY',-Number.MAX_VALUE);for(const k of ['retract','lift'])number(parking[k],k,0);for(const k of ['travelSpeed','liftSpeed','retractSpeed'])number(parking[k],k,Number.MIN_VALUE);
 if(Object.hasOwn(p,'bedHeater'))name(p.bedHeater,'bedHeater');if(Object.hasOwn(p,'homingTimeoutMs'))number(p.homingTimeoutMs,'homingTimeoutMs',1,3600000,true);
 if(Object.hasOwn(v,'deadlines')){const d=object(v.deadlines,'deadlines',[],['startMs','pauseMs','resumeMs','stopMs','finishMs']);for(const k of Object.keys(d))number(d[k],'deadlines.'+k,1,86400000,true);}
 if(Object.hasOwn(v,'hardware')){const hardware=object(v.hardware,'hardware',[],['timeoutMs','heaterGcodeIds']);if(Object.hasOwn(hardware,'timeoutMs'))number(hardware.timeoutMs,'hardware.timeoutMs',1,300000,true);if(Object.hasOwn(hardware,'heaterGcodeIds')){const mapping=hardware.heaterGcodeIds,keys=mapping&&typeof mapping==='object'?Object.keys(mapping):[];object(mapping,'heaterGcodeIds',keys);for(const k of keys){name(k,'heaterGcodeIds.key');name(mapping[k],'heaterGcodeIds.value');}}}
 return structuredClone(v) as ProductMachineConfiguration;
}
