// System information wire fields follow Moonraker machine.py (GPL-3.0-or-later).
import {open} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {cpus,machine,release} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {fixedDecimal} from '../math/python-decimal.ts';
import type {Json} from './rpc.ts';
export function osRelease(text:string):Record<string,Json>{
 const values:Record<string,string>=Object.create(null);
 for(const line of text.split('\n')){const match=/^([A-Z_]+)=(.*)$/.exec(line);if(!match)continue;let value=match[2];if(value.startsWith('"')&&value.endsWith('"'))value=value.slice(1,-1).replace(/\\([\\"$`])/g,'$1');else if(value.startsWith("'")&&value.endsWith("'"))value=value.slice(1,-1);values[match[1]]=value;}
 const version=values.VERSION_ID??'',parts=version.split('.');return {name:values.PRETTY_NAME??values.NAME??'',id:values.ID??'',version,version_parts:{major:parts[0]??'',minor:parts[1]??'',build_number:parts.slice(2).join('.')},like:values.ID_LIKE??'',codename:values.VERSION_CODENAME??values.UBUNTU_CODENAME??'',release_info:{},kernel_version:release()};
}
export function cpuInformation(cpu:string,memory:string,count:number,architecture:string,processor:string):Record<string,Json>{
 const last=cpu.trim().split(/\n\s*\n/).at(-1)??'',field=(name:string)=>new RegExp('^'+name+'\\s*:\\s*(.+)$','m').exec(last)?.[1].trim()??'',total=/^MemTotal:\s+(\d+)\s+(\w+)/m.exec(memory),number=total?Number(total[1]):NaN;
 return {cpu_count:count,bits:['ia32','arm'].includes(architecture)?'32bit':['x64','arm64','ppc64','s390x','riscv64','loong64','mips64el'].includes(architecture)?'64bit':'unknown',processor,cpu_desc:/^model name\s*:\s*(.+)$/m.exec(cpu)?.[1].trim()??'',serial_number:field('Serial').replace(/^0+(?=.)/,''),hardware_desc:field('Hardware'),model:field('Model'),total_memory:Number.isSafeInteger(number)?number:null,memory_units:Number.isSafeInteger(number)?total![2]:''};
}
export function sdInformation(cid:string,csd:string):Record<string,Json>{
 cid=cid.trim().toLowerCase();csd=csd.trim();if(!/^[0-9a-f]{32}$/.test(cid))return {};
 const month=Number.parseInt(cid[29],16);if(month<1||month>12)return {};
 const result:Record<string,Json>={manufacturer_id:cid.slice(0,2),manufacturer:({'1b':'Samsung','03':'Sandisk','74':'PNY'} as Record<string,string>)[cid.slice(0,2)]??'Unknown',oem_id:cid.slice(2,6),product_name:[...Buffer.from(cid.slice(6,16),'hex')].filter(n=>n<128).map(n=>String.fromCharCode(n)).join(''),product_revision:Number.parseInt(cid[16],16)+'.'+Number.parseInt(cid[17],16),serial_number:cid.slice(18,26),manufacturer_date:month+'/'+(Number.parseInt(cid.slice(27,29),16)+2000),capacity:'Unknown',total_bytes:0};
 if(!/^[0-9a-f]{32}$/i.test(csd))return result;const bytes=Buffer.from(csd,'hex'),type=bytes[0]>>6;let total:number,unit:string,divisor:number;
 if(type===0){total=((((bytes[6]&3)<<10)|(bytes[7]<<2)|(bytes[8]>>6))+1)*2**((((bytes[9]&3)<<1)|(bytes[10]>>7))+2)*2**(bytes[5]&15);unit='MiB';divisor=1024**2;}
 else if(type===1){total=(((bytes[7]&63)*65536+bytes[8]*256+bytes[9])+1)*512*1024;unit='GiB';divisor=1024**3;}
 else if(type===2){total=((bytes[6]&15)*16777216+bytes[7]*65536+bytes[8]*256+bytes[9]+1)*512*1024;unit='TiB';divisor=1024**4;}
 else return result;result.capacity=fixedDecimal(total/divisor,1)+' '+unit;result.total_bytes=total;return result;
}
export function networkInformation(value:unknown):{network:Record<string,Json>;canbus:Record<string,Json>}{
 const network:Record<string,Json>={},canbus:Record<string,Json>={};if(!Array.isArray(value)||value.length>2048)return {network,canbus};
 for(const row of value){if(!row||typeof row!=='object'||row.operstate!=='UP'||typeof row.ifname!=='string'||!/^[-\w.:@]{1,256}$/.test(row.ifname)||row.ifname==='__proto__')continue;
  if(row.link_type==='can'){const info=row.linkinfo?.info_data;canbus[row.ifname]={tx_queue_len:Number.isSafeInteger(row.txqlen)?row.txqlen:0,bitrate:Number.isSafeInteger(info?.bittiming?.bitrate)?info.bittiming.bitrate:-1,driver:typeof info?.bittiming_const?.name==='string'?info.bittiming_const.name:'unknown'};}
  else if(row.link_type==='ether'&&typeof row.address==='string'&&Array.isArray(row.addr_info)){const addresses=row.addr_info.filter((a:any)=>a&&['inet','inet6'].includes(a.family)&&typeof a.local==='string').map((a:any)=>({family:a.family==='inet'?'ipv4':'ipv6',address:a.local,is_link_local:a.scope==='link'}));if(addresses.length)network[row.ifname]={mac_address:row.address,ip_addresses:addresses};}
 }return {network,canbus};
}
/** Missing/failed commands are unknown, not evidence that links disappeared. */
export function linuxNetworkFields(value:string|null):Partial<ReturnType<typeof networkInformation>>{
 if(value===null)return {};try{
  const rows=JSON.parse(value);if(!Array.isArray(rows)||rows.length>2048)return {};
  for(const row of rows){
   if(!row||typeof row!=='object'||Array.isArray(row)||typeof row.operstate!=='string')return {};
   if(row.operstate!=='UP')continue;
   if(typeof row.link_type!=='string')return {};
   if(!['ether','can'].includes(row.link_type))continue;
   if(typeof row.ifname!=='string'||!/^[-\w.:@]{1,256}$/.test(row.ifname)||row.ifname==='__proto__')return {};
   if(row.link_type==='can'&&!Number.isSafeInteger(row.txqlen))return {};
   if(row.link_type==='ether'&&Object.hasOwn(row,'address')){
    if(typeof row.address!=='string'||row.addr_info!==undefined&&!Array.isArray(row.addr_info))return {};
    if((row.addr_info??[]).some((address:any)=>!address||typeof address!=='object'||Array.isArray(address)||Object.hasOwn(address,'family')&&Object.hasOwn(address,'local')&&(!['inet','inet6'].includes(address.family)||typeof address.local!=='string')))return {};
   }
  }
  return networkInformation(rows);
 }catch{return {};}
}
async function read(path:string,signal:AbortSignal):Promise<string>{let file:Awaited<ReturnType<typeof open>>|undefined;try{signal.throwIfAborted();file=await open(path,'r');const chunks:Buffer[]=[];let size=0;while(size<=1048576){signal.throwIfAborted();const buffer=Buffer.allocUnsafe(Math.min(32768,1048577-size)),{bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;chunks.push(buffer.subarray(0,bytesRead));}signal.throwIfAborted();return size>1048576?'':Buffer.concat(chunks,size).toString('utf8');}catch{signal.throwIfAborted();return '';}finally{await file?.close();}}
async function command(file:string,args:string[],signal:AbortSignal):Promise<string|null>{return new Promise((resolve,reject)=>{execFile(file,args,{signal,timeout:1000,maxBuffer:1048576,encoding:'utf8'},(error,stdout)=>{if(signal.aborted)reject(signal.reason);else resolve(error&&stdout.trim()!=='none'?null:stdout.trim());});});}
export type SystemInformationSource=(signal:AbortSignal)=>Promise<Record<string,Json>>;
export const linuxSystemInformation:SystemInformationSource=async signal=>{
 const settled=await Promise.allSettled([read('/etc/os-release',signal),read('/proc/cpuinfo',signal),read('/proc/meminfo',signal),read('/sys/block/mmcblk0/device/cid',signal),read('/sys/block/mmcblk0/device/csd',signal),command('ip',['-json','-details','address'],signal),command('systemd-detect-virt',[],signal),command('systemd-detect-virt',['--container'],signal)]);signal.throwIfAborted();const values=settled.map(r=>r.status==='fulfilled'?r.value:null),[os,cpu,mem,cid,csd,ip,virt,container]=values;
 const interfaces=linuxNetworkFields(ip);
 return {cpu_info:cpuInformation(cpu??'',mem??'',cpus().length,process.arch,machine()),sd_info:sdInformation(cid??'',csd??''),distribution:osRelease(os??''),virtualization:!virt?{virt_type:'unknown',virt_identifier:'unknown'}:virt==='none'?{virt_type:'none',virt_identifier:'none'}:{virt_type:container===null?'unknown':container!=='none'?'container':'vm',virt_identifier:virt},...interfaces,provider:'none',available_services:[],service_state:{},instance_ids:{moonraker:'',klipper:''},runtime:{name:'node',version:process.version}};
};
export class SystemInformation {
 readonly #source:SystemInformationSource;readonly #networkChanged:((network:Record<string,Json>)=>void|Promise<void>)|undefined;readonly #abort=new AbortController();#value:Record<string,Json>={};#pending:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#started=false;#samples=0;#failures=0;#notificationFailures=0;
 constructor(source:SystemInformationSource=linuxSystemInformation,networkChanged?:(network:Record<string,Json>)=>void|Promise<void>){if(typeof source!=='function'||networkChanged!==undefined&&typeof networkChanged!=='function')throw new TypeError('Invalid system information source');this.#source=source;this.#networkChanged=networkChanged;}
 get status(){return {samples:this.#samples,failures:this.#failures,pending:!!this.#pending,closed:this.#abort.signal.aborted,notification_failures:this.#notificationFailures};}
 snapshot():Json{return {system_info:structuredClone(this.#value)};}
 refresh():Promise<void>{
  if(this.#abort.signal.aborted)return Promise.reject(this.#abort.signal.reason);if(this.#pending)return this.#pending;
  const pending=this.#source(this.#abort.signal).then(async value=>{
   this.#abort.signal.throwIfAborted();const next=structuredClone(value),previous=this.#value;
   for(const field of ['network','canbus']){
    if(!Object.hasOwn(next,field))next[field]=structuredClone(previous[field]??{});
    if(!next[field]||typeof next[field]!=='object'||Array.isArray(next[field]))throw new TypeError('Invalid system network snapshot');
   }
   const changed=this.#samples>0&&!isDeepStrictEqual(previous.network,next.network);
   this.#value=next;this.#samples++;
   if(changed&&this.#networkChanged)try{await this.#networkChanged(structuredClone(next.network) as Record<string,Json>);}catch{this.#notificationFailures++;}
  }).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async start(){if(this.#started)return;this.#started=true;await this.refresh();this.#schedule();}
 #schedule(){if(this.#abort.signal.aborted)return;this.#timer=setTimeout(()=>{this.#timer=undefined;void this.refresh().catch(()=>{if(!this.#abort.signal.aborted)this.#failures++;}).finally(()=>this.#schedule());},10000);this.#timer.unref();}
 async close(){this.#abort.abort(new Error('System information closed'));clearTimeout(this.#timer);await this.#pending?.catch(()=>{});}
}
