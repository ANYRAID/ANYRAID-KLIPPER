import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sdFlashDevicePath,waitSDReconnect,sdFlashUART} from '../src/diagnostics/sd-flash-uart.ts';
const signal=()=>new AbortController().signal;
test('SD device selection keeps USB topology path and preserves explicit fallback symlink',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'sd-path-'));try{const device=join(dir,'tty'),alias=join(dir,'by-id'),paths=join(dir,'paths');await writeFile(device,'');await symlink(device,alias);await mkdir(paths);await symlink(device,join(paths,'usb-port'));assert.equal(await sdFlashDevicePath(alias,signal(),paths),join(paths,'usb-port'));assert.equal(await sdFlashDevicePath(alias,signal(),join(dir,'missing')),alias);await assert.rejects(sdFlashDevicePath('relative',signal(),paths),/absolute/);}finally{await rm(dir,{recursive:true,force:true});}
});
test('reconnect waits for stable presence, bounds absence, propagates permissions and cancellation',async()=>{
 let now=0;const clock={now:()=>now,async sleep(ms:number){now+=ms;},async exists(){return now!==3250;}};await waitSDReconnect('/dev/test',signal(),clock);assert.equal(now,3750);
 now=0;await assert.rejects(waitSDReconnect('/dev/test',signal(),{...clock,async exists(){return false;}}),/60 seconds/);assert.equal(now,60000);
 await assert.rejects(waitSDReconnect('/dev/test',signal(),{...clock,async exists(){throw new Error('permission denied');}}),/permission denied/);
 const controller=new AbortController();await assert.rejects(waitSDReconnect('/dev/test',controller.signal,{...clock,async sleep(){controller.abort(new Error('cancelled'));}}),/cancelled/);
});
test('UART adapter validates before opening any device',()=>{
 assert.throws(()=>sdFlashUART('relative',{baud:250000,async stopDevice(){}}),/Invalid/);assert.throws(()=>sdFlashUART('/dev/null',{baud:0,async stopDevice(){}}),/Invalid/);
});
test('offline UART adapter acquires a PTY, initializes firmware and releases exclusive ownership',async()=>{
 const {ptyPair}=await import('./helpers/pty.ts'),{serialFirmware}=await import('./helpers/serial-firmware.ts');const pair=ptyPair(),fw=await serialFirmware(pair);let stops=0;
 try{const io=sdFlashUART(pair.path,{baud:250000,leaveBootloader:false,async stopDevice(){stops++;}});const session=await io.connect(signal(),false);assert.equal(session.status.state,'ready');const reply=await session.query(session.dictionary.encode('echo',{value:123}),'echo_response',signal());assert.equal(reply.message.parameters.value,123);await session.stop();assert.equal(stops,1);}finally{await fw.close();}
});
