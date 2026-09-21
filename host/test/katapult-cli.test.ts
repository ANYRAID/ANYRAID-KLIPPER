import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {deflateSync} from 'node:zlib';
import {parseKatapultArgs} from '../src/diagnostics/katapult-cli.ts';
import {katapultPTY} from './helpers/katapult-pty.ts';
import {ptyPair} from './helpers/pty.ts';
const script=fileURLToPath(new URL('../../scripts/katapult.ts',import.meta.url));
function start(args:string[]){const child=spawn(process.execPath,[script,...args],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));});return {child,done};}
test('Katapult CLI validates modes, identities and ignored/conflicting options',()=>{
 const can=parseKatapultArgs(['-i','can1','-u','0xFFFF','--node-id','255','-f','image.bin']);assert.ok(!can.help);assert.equal(can.uuid,'00000000ffff');assert.equal(can.nodeId,255);
 assert.deepEqual(parseKatapultArgs(['--help']),{help:true});
 for(const args of [[],['-q','-s'],['-q','-u','1'],['-d','x','-u','1'],['-d','x','-i','can0'],['-d','x','-b','1.5'],['-u','1','--prime'],['-u','1','--node-id','256'],['-u','1','-s','-f','x'],['-d','x','-r','--already-bootloader'],['-d','x','--expected-mcu','']])assert.throws(()=>parseKatapultArgs(args),JSON.stringify(args));
});
test('serial CLI status and flash run through actual child, priming and complete verification',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'katapult-cli-'));try{const path=join(directory,'firmware.bin');await writeFile(path,Buffer.alloc(333,0xa5));
 for(const mode of ['status','flash']){const peer=katapultPTY({prime:true});try{const result=await start(['-d',peer.path,'--prime',...(mode==='status'?['-s']:['-f',path,'-v'])]).done;assert.equal(result.code,0,result.stderr);assert.match(result.stdout,mode==='status'?/Status Request Complete/:/Programming Complete/);assert.equal(peer.commands[0],0x90);assert.equal(peer.commands.at(-1),mode==='status'?0x11:0x15);if(mode==='status'){assert.equal(peer.commands.length,2);assert.match(result.stdout,/stm32f407/);}}finally{await peer.close();}}
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('serial boot request emits exact legacy bytes once; SIGTERM interrupts status without completion',async()=>{
 const pair=ptyPair(),bytes:Buffer[]=[];pair.peer.on('data',(b:Buffer)=>bytes.push(b));try{const result=await start(['-d',pair.path,'-r']).done;assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/Bootloader Request Complete/);assert.deepEqual(Buffer.concat(bytes),Buffer.from('~ \x1c Request Serial Bootloader!! ~'));}finally{await pair.close();}
 const peer=katapultPTY({silent:true}),running=start(['-d',peer.path,'-s']);try{for(let i=0;!peer.commands.length;i++){if(i>200)throw new Error('CLI did not connect');await delay(10);}running.child.kill('SIGTERM');const result=await running.done;assert.equal(result.code,1);assert.doesNotMatch(result.stdout,/Complete/);assert.deepEqual(peer.commands,[0x11]);}finally{if(running.child.exitCode===null)running.child.kill('SIGKILL');await peer.close();}
});
test('explicit firmware identity conflict fails before a serial request or CONNECT',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'katapult-cli-id-')),peer=katapultPTY();try{const path=join(directory,'klipper.bin');await writeFile(path,deflateSync(JSON.stringify({app:'Klipper',config:{MCU:'stm32f407'}})));const result=await start(['-d',peer.path,'-f',path,'--expected-mcu','other']).done;assert.equal(result.code,1);assert.match(result.stderr,/does not match/);assert.equal(peer.commands.length,0);}finally{await peer.close();await rm(directory,{recursive:true,force:true});}
});
