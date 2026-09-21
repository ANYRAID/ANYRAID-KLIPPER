import {parseArgs} from 'node:util';
import {open,mkdtemp,writeFile,rm,realpath,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {basename,dirname,extname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {flashUsb,usbFlashTarget,type UsbFlashOptions} from './flash-usb.ts';
import {createUsbFlashSystem} from './flash-usb-system.ts';
import {openKatapultSerial,katapultNeedsPriming} from './katapult-serial.ts';
import {flashKatapultFirmware} from './firmware-identity.ts';
const repository=fileURLToPath(new URL('../../..',import.meta.url));
const help='Usage: node scripts/flash_usb.ts -t MCU -d DEVICE [-s ADDRESS] [--no-sudo] FIRMWARE\n       node scripts/flash_usb.ts --katapult -d DEVICE [--prime] FIRMWARE\n--katapult requires a device already running Katapult; no reboot is requested.\n';
export function parseUsbFlashArgs(argv:string[]):{help:true}|{help:false;target:UsbFlashOptions;katapult:boolean;prime:boolean}{
 const {values,positionals}=parseArgs({args:argv,allowPositionals:true,options:{type:{type:'string',short:'t'},device:{type:'string',short:'d'},start:{type:'string',short:'s'},'no-sudo':{type:'boolean'},katapult:{type:'boolean'},prime:{type:'boolean'},help:{type:'boolean',short:'h'}}});
 if(values.help)return {help:true};
 if(positionals.length!==1||!values.device||!values.katapult&&!values.type)throw new Error('Specify MCU, device and one firmware file');
 let start:number|undefined;
 if(values.start!==undefined){if(!/^(?:0[xX][a-fA-F\d]+|0[bB][01]+|0[oO][0-7]+|\d+)$/.test(values.start))throw new Error('Invalid flash start address');start=Number(values.start);if(!Number.isInteger(start)||start<0||start>0xffffffff)throw new RangeError('Invalid flash start address');}
 if(values.prime&&!values.katapult)throw new Error('--prime requires --katapult');
 if(values.katapult&&(values.type!==undefined||values.start!==undefined||values['no-sudo']))throw new Error('--katapult does not accept MCU routing, address or sudo options');
 if(values.device.includes('\0')||values.device.length>4096||positionals[0].includes('\0'))throw new Error('Invalid device or firmware path');
 const target={mcu:values.type??'',device:values.katapult?resolve(values.device):values.device,image:resolve(positionals[0]),start,sudo:!values['no-sudo']};
 if(!values.katapult)usbFlashTarget(target);
 return {help:false,target,katapult:values.katapult??false,prime:values.prime??false};
}
/** Bounded read of a regular file, rejecting changes observed during the read. */
export async function readUsbFirmware(path:string,signal:AbortSignal):Promise<Buffer>{
 signal.throwIfAborted();const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{
  const before=await file.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>64n*1024n*1024n)throw new Error('Firmware must be a nonempty regular file up to 64 MiB');
  const bytes=Buffer.alloc(Number(before.size)+1);let length=0;
  while(length<bytes.length){signal.throwIfAborted();const result=await file.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
  const after=await file.stat({bigint:true});signal.throwIfAborted();
  if(length!==Number(before.size)||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)throw new Error('Firmware changed while reading');
  return bytes.subarray(0,length);
 }finally{await file.close();}
}
async function usbProduct(device:string,signal:AbortSignal):Promise<string>{
 let current:string;
 try{current=await realpath(join('/sys/class/tty',basename(await realpath(device))));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;}
 while(current!=='/'){
  signal.throwIfAborted();try{return (await readFile(join(current,'product'),{encoding:'utf8',signal})).trim().toLowerCase();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  current=dirname(current);
 }
 return '';
}
export async function runUsbFlash(argv:string[],signal:AbortSignal,output:(text:string)=>void=()=>{}):Promise<void>{
 const parsed=parseUsbFlashArgs(argv);if(parsed.help){output(help);return;}
 const firmware=await readUsbFirmware(parsed.target.image,signal);
 const katapult=async(device:string,_image:string,active:AbortSignal)=>{
  const prime=parsed.prime||katapultNeedsPriming(await usbProduct(device,active));
  const transport=openKatapultSerial(device,{prime},active);
  let result:Awaited<ReturnType<typeof flashKatapultFirmware>>;
  try{result=await flashKatapultFirmware(firmware,transport,active);}finally{transport.close();}
  output(`Katapult verified ${result.blocks} blocks, SHA-1 ${result.sha1}\n`);
 };
 if(parsed.katapult){await katapult(parsed.target.device,parsed.target.image,signal);return;}
 // External writers must receive the validated snapshot, not a mutable source.
 const directory=await mkdtemp(join(tmpdir(),'anyraid-usb-flash-'));
 try{
  const image=join(directory,'firmware'+extname(parsed.target.image));await writeFile(image,firmware,{mode:0o600,flag:'wx',signal});signal.throwIfAborted();
  await flashUsb({...parsed.target,image},createUsbFlashSystem({repository,katapult}),signal);
  output('USB flash command completed.\n');
 }finally{await rm(directory,{recursive:true,force:true});}
}
