import test from 'node:test';
import {closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,readdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseMcuDumpArgs,runMcuDump} from '../src/diagnostics/mcu-dump-cli.ts';
import {ptyPair} from './helpers/pty.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const native=createRequire(import.meta.url)('../build/serialqueue.node');
const prepare=(path:string)=>closeSync(native.openUART(path,250000,true));
const cli=fileURLToPath(new URL('../../scripts/dump_mcu.ts',import.meta.url));
test('dump CLI validates ranges and conflicting transports before I/O',()=>{
 assert.equal(parseMcuDumpArgs(['-c','vcan0','-i','255','-s','0xfffffff8','-l','8','11aa22bb33cc','dump.bin'])?.range.start,0xfffffff8);
 for(const args of [['-l','0'],['-s','0xffffffff','-l','2'],['-c','can0','--pipe'],['-i','64'],['--connect-timeout','0'],['-b','NaN'],['--read_length','-1']])assert.throws(()=>parseMcuDumpArgs([...args,'11aa22bb33cc','dump.bin']));
 const result=spawnSync(process.execPath,[cli,'--help'],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/read_start/);
});
test('dump CLI completes real UART and prepared PTY subprocess transfers',async()=>{
 for(const pipe of [false,true]){
  const pair=ptyPair(),dir=await mkdtemp(join(tmpdir(),'dump-cli-')),output=join(dir,'dump.bin'),requests:number[]=[];
  if(pipe)prepare(pair.path);
  const fw=await serialFirmware(pair,{debugRead(_order,address){requests.push(address);return 0xfedcba98;}});
  try{const child=spawn(process.execPath,[cli,...pipe?['--pipe']:['--no-bootloader'],'-s','0xfffffff8','-l','8',pair.path,output]);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,0,`pipe=${pipe} ${stdout} ${stderr}`);assert.match(stdout,/MCU Dump Complete/);assert.deepEqual(requests,[0xfffffff8,0xfffffffc]);assert.deepEqual(await readFile(output),Buffer.from('98badcfe98badcfe','hex'));}finally{clearTimeout(timer);}}finally{await fw.close();await rm(dir,{recursive:true,force:true});}
 }
});
test('dump CLI aborts active reads, preserves old output, and removes temporary files',async()=>{
 const pair=ptyPair(),dir=await mkdtemp(join(tmpdir(),'dump-cancel-')),output=join(dir,'dump.bin'),fw=await serialFirmware(pair,{debugRead:()=>0});prepare(pair.path);fw.ignore('debug_read');await writeFile(output,'old');
 try{const child=spawn(process.execPath,[cli,'--pipe','-l','8',pair.path,output]);let stdout='',stderr='',cancelled=false;child.stdout.on('data',b=>{stdout+=b;if(!cancelled&&stdout.includes('reading')){cancelled=true;setTimeout(()=>child.kill('SIGINT'),20);}});child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});assert.equal(code,1,stderr);assert.match(stderr,/cancelled/);assert.doesNotMatch(stdout,/Complete/);assert.equal(await readFile(output,'utf8'),'old');assert.deepEqual(await readdir(dir),['dump.bin']);}finally{clearTimeout(timer);}}finally{await fw.close();await rm(dir,{recursive:true,force:true});}
});
test('dump CLI rejects non-regular output and regular-file pipe devices without altering files',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dump-path-')),device=join(dir,'device'),output=join(dir,'out');
 try{await writeFile(device,'unchanged');await symlink(device,output);await assert.rejects(runMcuDump(['--pipe',device,output],new AbortController().signal,()=>{}),/regular file/);await rm(output);await assert.rejects(runMcuDump(['--pipe',device,output],new AbortController().signal,()=>{}),/^Error: Inspect pipe:/);assert.equal(await readFile(device,'utf8'),'unchanged');assert.deepEqual(await readdir(dir),['device']);}finally{await rm(dir,{recursive:true,force:true});}
});
