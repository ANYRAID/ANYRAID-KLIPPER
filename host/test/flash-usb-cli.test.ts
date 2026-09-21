import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {parseUsbFlashArgs,readUsbFirmware} from '../src/diagnostics/flash-usb-cli.ts';
import {katapultPTY} from './helpers/katapult-pty.ts';
const script=fileURLToPath(new URL('../../scripts/flash_usb.ts',import.meta.url));
function start(args:string[],env=process.env){const child=spawn(process.execPath,[script,...args],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});return {child,done};}
test('USB CLI parses original routing arguments and rejects invalid/ambiguous options',()=>{
 const parsed=parseUsbFlashArgs(['-t','stm32f407','-d','0483:df11','-s','0x8000000','--no-sudo','firmware.bin']);assert.ok(!parsed.help);assert.equal(parsed.target.start,0x8000000);assert.equal(parsed.target.sudo,false);assert.equal(parsed.target.image,resolve('firmware.bin'));
 for(const args of [[],['-t','x','-d','x','f'],['--katapult','-d','x','-s','0','f'],['--katapult','-d','x','--no-sudo','f'],['-t','sam3','-d','x','--prime','f'],['-t','sam3','-d','x','-s','4294967296','f']])assert.throws(()=>parseUsbFlashArgs(args));
 assert.deepEqual(parseUsbFlashArgs(['--help']),{help:true});
});
test('USB CLI programs a real PTY Katapult via child process, including priming and completion',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'usb-cli-')),peer=katapultPTY({prime:true});
 try{const path=join(directory,'image with spaces.bin');await writeFile(path,Buffer.alloc(333,0xa5));const result=await start(['--katapult','--prime','-d',peer.path,path]).done;assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/verified 2 blocks/);assert.equal(peer.commands[0],0x90);assert.equal(peer.commands.at(-1),0x15);}finally{await peer.close();await rm(directory,{recursive:true,force:true});}
});
test('USB CLI passes a private firmware snapshot to external writer and deletes it after exit',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'usb-writer-'));
 try{const source=join(directory,'image.bin'),log=join(directory,'log.json');await writeFile(source,Buffer.from('firmware-data'));
  await writeFile(join(directory,'dfu-util'),'#!'+process.execPath+'\nconst fs=require("node:fs");const args=process.argv.slice(2),image=args[args.indexOf("-D")+1];fs.writeFileSync(process.env.USB_TEST_LOG,JSON.stringify({args,cwd:process.cwd(),image,data:fs.readFileSync(image,"utf8")}));\n',{mode:0o700});
  const result=await start(['-t','stm32f407','-s','0x8000000','-d','0483:df11','--no-sudo',source],{...process.env,PATH:directory,USB_TEST_LOG:log}).done;assert.equal(result.code,0,result.stderr);const record=JSON.parse(await readFile(log,'utf8'));assert.equal(record.data,'firmware-data');assert.notEqual(record.image,source);assert.equal(record.cwd,fileURLToPath(new URL('../..',import.meta.url)).replace(/\/$/,''));assert.deepEqual(record.args.slice(0,-1),['-d',',0483:df11','-R','-a','0','-s','0x8000000:leave','-D']);await assert.rejects(access(record.image),{code:'ENOENT'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('USB CLI rejects invalid firmware before opening port and SIGTERM cancels active read',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'usb-cancel-')),peer=katapultPTY({silent:true});
 try{const empty=join(directory,'empty.bin');await writeFile(empty,'');await assert.rejects(readUsbFirmware(empty,new AbortController().signal),/nonempty/);await assert.rejects(readUsbFirmware(directory,new AbortController().signal),/regular/);
  const invalid=await start(['--katapult','-d',peer.path,empty]).done;assert.equal(invalid.code,1);assert.equal(peer.commands.length,0);
  await writeFile(empty,Buffer.alloc(32));const running=start(['--katapult','-d',peer.path,empty]);try{for(let i=0;!peer.commands.length;i++){if(i>200)throw new Error('CLI did not connect');await delay(10);}running.child.kill('SIGTERM');const result=await running.done;assert.equal(result.code,1);assert.doesNotMatch(result.stdout,/verified/);assert.match(result.stderr,/cancelled|closed/);assert.deepEqual(peer.commands,[0x11]);}finally{if(running.child.exitCode===null)running.child.kill('SIGKILL');}
 }finally{await peer.close();await rm(directory,{recursive:true,force:true});}
});
