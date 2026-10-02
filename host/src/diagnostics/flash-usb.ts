// GPL-3.0-or-later. USB flashing orchestration from scripts/flash_usb.py
// (Kevin O'Connor, 2019). Hardware actions are supplied by the owning executor.
import {isAbsolute,dirname,join} from 'node:path';
export interface UsbFlashOptions {mcu:string;device:string;image:string;start?:number;sudo?:boolean;}
export interface UsbFlashIO {
 serialPaths(device:string,signal:AbortSignal):Promise<{tty:string;stable:string}>;
 usbPath(device:string,signal:AbortSignal):Promise<{busPath:string;devicePath:string}>;
 enterBootloader(device:string,signal:AbortSignal):Promise<void>;
 waitPath(path:string,alternative:string|undefined,signal:AbortSignal):Promise<string>;
 isKatapult(devicePath:string,signal:AbortSignal):Promise<boolean>;
 readText(path:string,signal:AbortSignal):Promise<string>;
 run(command:readonly string[],signal:AbortSignal):Promise<void>;
 katapult(device:string,image:string,signal:AbortSignal):Promise<void>;
}
export class UsbFlashExitError extends Error {readonly exitCode:number;constructor(command:string,exitCode:number){super(`${command} exited with status ${exitCode}`);this.exitCode=exitCode;}}
const routes=[['sam3','sam3'],['sam4','sam4'],['same70','sam4'],['samd','samd'],['same5','samd'],['lpc176','dfu'],['stm32f103','f1'],['stm32f4','stm'],['stm32f042','stm'],['stm32f070','stm'],['stm32f072','stm'],['stm32g0b1','stm'],['stm32f7','stm'],['stm32h7','stm'],['stm32l4','stm'],['stm32g4','stm'],['rp2','pico']] as const;
export function usbFlashTarget(options:UsbFlashOptions){
 const {mcu,device,image,start}=options,sudo=options.sudo??true;
 if(typeof mcu!=='string'||typeof device!=='string'||!device||device.includes('\0')||device.length>4096||typeof image!=='string'||!isAbsolute(image)||image.includes('\0')||typeof sudo!=='boolean')throw new TypeError('Invalid USB flash options');
 const route=routes.find(([prefix])=>mcu.startsWith(prefix))?.[1];if(!route)throw new Error(`USB flashing is not supported for MCU '${mcu}'`);
 if(start!==undefined&&(!Number.isInteger(start)||start<0||start>0xffffffff)||['samd','f1','stm'].includes(route)&&start===undefined)throw new RangeError('A uint32 flash start address is required');
 return {mcu,device,image,start,sudo,route};
}
/** This is the protocol/command orchestration layer, not a process or USB backend.
 * No reconnect/retry wraps a write command. Cancellation stops before subsequent
 * actions but cannot roll back firmware bytes already written. */
export async function flashUsb(options:UsbFlashOptions,io:UsbFlashIO,signal:AbortSignal):Promise<void>{
 const o=usbFlashTarget({...options});signal.throwIfAborted();
 const checked=async<T>(action:()=>Promise<T>)=>{signal.throwIfAborted();const value=await action();signal.throwIfAborted();return value;};
 const run=(command:string[])=>checked(()=>io.run(o.sudo?['sudo',...command]:command,signal));
 if(o.route==='sam3'||o.route==='sam4'||o.route==='samd'){
  const {tty,stable}=await checked(()=>io.serialPaths(o.device,signal));await checked(()=>io.enterBootloader(stable,signal));const port=await checked(()=>io.waitPath(stable,tty,signal));
  const base=['lib/bossac/bin/bossac','-U','-p',port],flags=o.route==='sam3'?['-e','-b']:o.route==='sam4'?['-e']:[`--offset=0x${o.start!.toString(16)}`,'-b','-R'];
  await checked(()=>io.run([...base,...flags,'-w',o.image,'-v'],signal));
  if(!flags.includes('-R')){try{await checked(()=>io.run([...base,'-b','-R'],signal));if(!flags.includes('-b')){await checked(()=>io.waitPath(port,undefined,signal));await checked(()=>io.run([...base,'-b','-R'],signal));}}catch(error){signal.throwIfAborted();if(!(error instanceof UsbFlashExitError))throw error;/* Original bossac reset may exit nonzero after successful write. */}}
  return;
 }
 const hid=o.route==='f1'&&o.start===0x8000800||o.route==='stm'&&o.start===0x8004000;
 const dfuFlags=o.route==='f1'?['-R','-a','2']:o.route==='stm'?['-R','-a','0','-s',`0x${o.start!.toString(16)}:leave`]:[];
 const dfu=(selector:string[])=>run(['dfu-util',...selector,...dfuFlags,'-D',o.image]);
 const hidFlash=()=>run(['lib/hidflash/hid-flash',o.image]);
 const pico=(address?:{bus:string;device:string})=>run(['lib/rp2040_flash/rp2040_flash',o.image,...address?[address.bus,address.device]:[]]);
 if(o.route==='pico'&&o.device.toLowerCase()===(o.mcu==='rp2350'?'2e8a:000f':'2e8a:0003')){await pico();return;}
 if(o.route!=='pico'&&/^[a-f\d]{4}:[a-f\d]{4}$/i.test(o.device.trim())){await (hid?hidFlash():dfu(['-d',','+o.device.trim()]));return;}
 const {stable}=await checked(()=>io.serialPaths(o.device,signal)),{busPath,devicePath}=await checked(()=>io.usbPath(o.device,signal));await checked(()=>io.enterBootloader(o.device,signal));
 let address:{bus:string;device:string}|undefined;
 if(o.route==='pico'){
  const directory=dirname(devicePath);await checked(()=>io.waitPath(join(directory,'busnum'),undefined,signal));
  const bus=(await checked(()=>io.readText(join(directory,'busnum'),signal))).trim(),device=(await checked(()=>io.readText(join(directory,'devnum'),signal))).trim();
  if(!/^\d+$/.test(bus)||!/^\d+$/.test(device))throw new Error('Invalid USB bus or device number');address={bus,device};
 }else await checked(()=>io.waitPath(devicePath,undefined,signal));
 if(await checked(()=>io.isKatapult(devicePath,signal))){await checked(()=>io.katapult(stable,o.image,signal));return;}
 await (o.route==='pico'?pico(address):hid?hidFlash():dfu(['-p',busPath]));
}
