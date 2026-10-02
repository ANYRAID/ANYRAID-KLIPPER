import test from 'node:test';
import assert from 'node:assert/strict';
import {closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ptyPair} from './helpers/pty.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {parseConsoleArgs} from '../src/diagnostics/mcu-console-cli.ts';
const native=createRequire(import.meta.url)('../build/serialqueue.node'),cli=fileURLToPath(new URL('../../scripts/console.ts',import.meta.url));
test('console validates transport options and provides help',()=>{
 assert.equal(parseConsoleArgs(['-b','250000','/tmp/pseudoserial'])?.pipe,false);
 assert.equal(parseConsoleArgs(['--canbus_iface','vcan0','-i','255','11aa'])?.nodeId,255);
 for(const args of [['-c','can0','--pipe','11aa'],['-i','1','/dev/test'],['-b','0','/dev/test'],['--connect-timeout','0','/tmp/test']])assert.throws(()=>parseConsoleArgs(args));
 const result=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/FLOOD/);
});
for(const pipe of [true,false])test('console CLI executes through '+(pipe?'prepared PTY':'UART')+' and drains EOF',async()=>{
 const pair=ptyPair();if(pipe)closeSync(native.openUART(pair.path,250000,true));const fw=await serialFirmware(pair,{debugRead:()=>0x64636261});
 try{const child=spawn(process.execPath,[cli,...pipe?['--pipe']:['--no-bootloader'],pair.path]);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
  try{child.stdin.end('SET value 40\necho value={value+2}\nDELAY {clock+freq*.01} echo value=43\nFLOOD 3 .001 echo value=44\nDUMP 0x1000 4 32\nSTATS\nLIST\n');const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,stdout+'\n'+stderr);assert.equal(stderr,'');assert.match(stdout,/echo_response value=42/);assert.match(stdout,/echo_response value=43/);assert.equal(stdout.match(/echo_response value=44/g)?.length,3);assert.match(stdout,/00001000  64636261/);assert.match(stdout,/bytes_write/);assert.doesNotMatch(stdout,/Error:/);
  }finally{clearTimeout(timer);}
 }finally{await fw.close();}
});
test('console SIGINT cancels an outstanding debug read and exits without replay',async()=>{
 const pair=ptyPair();closeSync(native.openUART(pair.path,250000,true));const fw=await serialFirmware(pair,{debugRead:()=>0});fw.ignore('debug_read');
 try{const child=spawn(process.execPath,[cli,'--pipe',pair.path]);let stdout='',stderr='',sent=false;child.stdout.on('data',b=>{stdout+=b;if(!sent&&stdout.includes('Connected:')){sent=true;child.stdin.write('DUMP 0x1000 4\n');setTimeout(()=>child.kill('SIGINT'),30);}});child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
 try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,1,stdout+'\n'+stderr);assert.match(stderr,/cancelled/);assert.doesNotMatch(stdout,/00001000/);}finally{clearTimeout(timer);}
 }finally{await fw.close();}
});
