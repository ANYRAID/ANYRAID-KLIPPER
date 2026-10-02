import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,openSync,closeSync,readSync,writeSync,existsSync,constants,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {AVREngine} from '../src/simulator/engine.ts';
import {simulatorTerminal} from '../src/simulator/terminal.ts';
const binary=fileURLToPath(new URL('../build/avrsim',import.meta.url));
function compile(name:string,output:string){const r=spawnSync(process.env.AVR_CC??'avr-gcc',['-mmcu=atmega644','-Os',fileURLToPath(new URL('../test/fixtures/simulavr/'+name+'.c',import.meta.url)),'-o',output],{encoding:'utf8'});assert.equal(r.status,0,String(r.error??r.stderr));}
test('VCD trace preserves real AVR pulse timestamps and signal discovery',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'avr-vcd-'));let engine:AVREngine|undefined;
 try{
  const elf=join(dir,'pulse.elf'),vcd=join(dir,'pulse.vcd');compile('pulse',elf);
  const list=spawnSync(binary,['atmega644','16000000','250000',elf,'ignored','?'],{encoding:'utf8',timeout:5000});assert.equal(list.status,0);assert.match(list.stdout,/PORTA\.PORT/);
  engine=new AVREngine(binary,elf,{trace:{file:vcd,signals:'PORTA.PORT'}});const result=await engine.advance(1000000);await engine.close();
  const text=readFileSync(vcd,'utf8');assert.match(text,/\$timescale 1ns \$end/);assert.match(text,/PORT/);
  const changes:{time:bigint;value:string}[]=[];let time=0n;
  for(const line of text.split('\n')){if(/^#\d+$/.test(line))time=BigInt(line.slice(1));else if(/^b[01]+ /.test(line))changes.push({time,value:line.split(' ')[0]});}
  const firstHigh=changes.findIndex(e=>e.value==='b00000001');assert.ok(firstHigh>=0,text.slice(0,500));
  const pulses=changes.slice(firstHigh);assert.ok(pulses.length>=5000);
  for(let i=1;i<pulses.length;i++)assert.equal(pulses[i].time-pulses[i-1].time,i%2?124n:248n);
  assert.ok(time<=result.time);
 }finally{await engine?.abort();rmSync(dir,{recursive:true,force:true});}
});
test('PTY ownership refuses existing paths and preserves a replacement at shutdown',()=>{
 const dir=mkdtempSync(join(tmpdir(),'avr-pty-owner-')),link=join(dir,'serial');
 try{
  writeFileSync(link,'keep');assert.throws(()=>simulatorTerminal(link),/EEXIST/);assert.equal(readFileSync(link,'utf8'),'keep');
  unlinkSync(link);const terminal=simulatorTerminal(link);unlinkSync(link);writeFileSync(link,'replacement');terminal.close();terminal.close();assert.equal(readFileSync(link,'utf8'),'replacement');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
for(const rate of [.1,0])test(`Node CLI raw PTY echoes every byte at rate ${rate} and cleans up on termination`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'avr-cli-')),elf=join(dir,'echo.elf'),port=join(dir,'serial');compile('echo',elf);
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../scripts/avrsim.ts',import.meta.url)),'--port',port,'--rate',String(rate),elf],{stdio:['ignore','pipe','pipe'],env:{...process.env,PATH:'/no-programs',NODE_OPTIONS:''}});
 let out='',err='',fd:number|undefined;child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
 const ended=new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});void ended.catch(()=>{});
 try{
  const deadline=performance.now()+10000;while(!out.includes('Serial:')){assert.ok(performance.now()<deadline,err);await delay(5);}
  fd=openSync(port,constants.O_RDWR|constants.O_NONBLOCK|constants.O_NOCTTY);await delay(30);
  const input=Buffer.from(Array.from({length:256},(_,i)=>i)),chunks:Buffer[]=[];let count=0;const started=performance.now();assert.equal(writeSync(fd,input),256);
  while(count<256){const buffer=Buffer.alloc(256);try{const size=readSync(fd,buffer);if(size){chunks.push(buffer.subarray(0,size));count+=size;}}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}assert.ok(performance.now()<deadline,err);await delay(1);}
  const elapsed=performance.now()-started;assert.deepEqual(Buffer.concat(chunks),input);if(rate)assert.ok(elapsed>=70,'pacing must not run 256-byte transfer at unlimited speed');
  child.kill(rate?'SIGTERM':'SIGINT');assert.equal(await ended,0,err);assert.equal(existsSync(port),false);t.diagnostic(JSON.stringify({bytes:256,rate,roundTripMs:elapsed}));
 }finally{if(fd!==undefined)closeSync(fd);child.kill('SIGKILL');await ended.catch(()=>{});rmSync(dir,{recursive:true,force:true});}
});
