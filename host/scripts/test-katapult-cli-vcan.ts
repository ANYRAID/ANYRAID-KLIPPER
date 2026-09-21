import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {mkdtempSync,rmSync,readlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {katapultSimulator} from '../bench/katapult-reference.ts';
const script=fileURLToPath(import.meta.url),host=fileURLToPath(new URL('..',import.meta.url)),cliPath=resolve(host,'../scripts/katapult.ts');
function env(){const out={...process.env};delete out.LD_PRELOAD;delete out.ASAN_OPTIONS;return out;}
function command(name:string,args:string[]){const r=spawnSync(name,args,{env:env(),encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr||String(r.error));}
async function runCli(args:string[],onSpawn:(child:ChildProcess)=>void=()=>{},overrides:NodeJS.ProcessEnv={}){const child=spawn(process.execPath,[cliPath,...args],{env:{...process.env,...overrides},stdio:['ignore','pipe','pipe']});onSpawn(child);let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const timer=setTimeout(()=>child.kill('SIGKILL'),6000);try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});return {code,stdout,stderr};}finally{clearTimeout(timer);}}
async function inside(executable:string,queryPeer:string){
 assert.ok(process.env.KATAPULT_PARENT_NET&&process.env.KATAPULT_PARENT_USER);assert.notEqual(readlinkSync('/proc/self/ns/net'),process.env.KATAPULT_PARENT_NET);assert.notEqual(readlinkSync('/proc/self/ns/user'),process.env.KATAPULT_PARENT_USER);
 command('ip',['link','add','dev','vcan-test','type','vcan']);command('ip',['link','set','dev','vcan-test','up']);
 const directory=mkdtempSync(resolve(tmpdir(),'katapult-cli-can-')),image=resolve(directory,'firmware.bin'),samples:number[]=[];writeFileSync(image,Buffer.alloc(4093,0xa5));
 try{
 for(const mode of [...Array.from({length:16},()=> 'flash'),'status','request','cancel']){
  const peer=spawn(executable,['112233445566',...mode==='status'?[]:['reboot']],{env:env(),stdio:['pipe','pipe','pipe']}),sim=katapultSimulator(256),seen:number[]=[];
  let diagnostic='',buffer:Buffer=Buffer.alloc(0),chain=Promise.resolve(),fault:unknown,cli:ChildProcess|undefined;
  peer.stderr.on('data',b=>{diagnostic+=b;if(mode==='cancel'&&diagnostic.includes('REBOOT\n'))cli?.kill('SIGTERM');});peer.stdin.on('error',()=>{});
  const ended=new Promise<number|null>((resolve,reject)=>{peer.once('error',reject);peer.once('close',resolve);});void ended.catch(()=>{});
  peer.stdout.on('data',(bytes:Buffer)=>{buffer=Buffer.concat([buffer,bytes]);while(buffer.length>=4){const length=buffer[3]*4+8;if(buffer.length<length)break;const frame=Buffer.from(buffer.subarray(0,length));buffer=buffer.subarray(length);seen.push(frame[2]);chain=chain.then(async()=>{peer.stdin.write(await sim.transport.exchange(frame,2000,new AbortController().signal));}).catch(error=>{fault=error;});}});
  try{
   const deadline=performance.now()+3000;while(!diagnostic.includes('READY\n')){assert.equal(peer.exitCode,null,diagnostic);assert.ok(performance.now()<deadline);await delay(1);}
   const args=['-i','vcan-test','-u','112233445566',...mode==='status'?['-s']:mode==='request'?['-r']:['-f',image]],at=performance.now(),result=await runCli(args,child=>cli=child),elapsed=performance.now()-at;
   assert.equal(result.code,mode==='cancel'?1:0,result.stderr);
   assert.equal((diagnostic.match(/REBOOT/g)||[]).length,mode==='status'?0:1);
   assert.equal((diagnostic.match(/ASSIGNED/g)||[]).length,mode==='request'||mode==='cancel'?0:1);
   if(mode==='flash'){samples.push(elapsed);assert.match(result.stdout,/Programming Complete/);assert.equal(seen[1],0x16);assert.equal(seen.at(-1),0x15);assert.equal(seen.length,36);}
   else if(mode==='status'){assert.match(result.stdout,/Status Request Complete/);assert.match(result.stdout,/stm32f407/);assert.deepEqual(seen,[0x11,0x16]);}
   else{assert.equal(seen.length,0);if(mode==='request')assert.match(result.stdout,/Bootloader Request Complete/);else assert.doesNotMatch(result.stdout,/Complete/);}
   assert.equal(fault,undefined);
  }finally{await chain;peer.stdin.end();const kill=setTimeout(()=>peer.kill('SIGKILL'),2000);try{assert.equal(await ended,0,diagnostic);}finally{clearTimeout(kill);}}
 }
 const resetSamples:number[]=[];
 for(const queryMode of ['normal',...Array.from({length:16},()=> 'reset'),'cancel','unavailable']){
 let queryCli:ChildProcess|undefined;
 const peer=spawn(queryPeer,queryMode==='normal'?[]:[queryMode==='unavailable'?'idle':queryMode],{env:env(),stdio:['ignore','pipe','pipe']});let ready='',diagnostic='';peer.stdout.on('data',b=>{ready+=b;if(queryMode==='cancel'&&ready.includes('RESET\n'))queryCli?.kill('SIGTERM');});peer.stderr.on('data',b=>diagnostic+=b);const ended=new Promise((resolve,reject)=>{peer.once('error',reject);peer.once('close',resolve);});try{const deadline=performance.now()+3000;while(!ready.includes('READY\n')){assert.ok(performance.now()<deadline,diagnostic);await delay(1);}const at=performance.now(),result=await runCli(['-i','vcan-test','-q',...queryMode==='normal'?[]:['--reset-node-ids']],child=>queryCli=child,queryMode==='unavailable'?{ANYRAID_CAN_QUERY_ADDON:resolve(directory,'missing-addon.node')}:{});if(queryMode==='unavailable'){assert.equal(result.code,1);assert.match(result.stderr,/Cannot find module/);assert.doesNotMatch(result.stdout,/reset request sent|Complete/);}else if(queryMode==='cancel'){assert.equal(result.code,1,result.stderr);assert.doesNotMatch(result.stdout,/Query Complete/);}else{assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/ffffffffffff, Application: Katapult/);assert.match(result.stdout,/CANBus UUID Query Complete/);if(queryMode==='reset'){resetSamples.push(performance.now()-at);assert.match(result.stdout,/node ID reset request sent/);}}assert.equal((ready.match(/RESET/g)||[]).length,queryMode==='normal'||queryMode==='unavailable'?0:1);assert.equal(await ended,0,diagnostic);}finally{if(peer.exitCode===null)peer.kill('SIGKILL');await ended;}
 }
 const resetTiming=resetSamples.slice(5).sort((a,b)=>a-b);console.log(JSON.stringify({resetQuery:{warmup:5,runs:11,medianMs:resetTiming[5],p95Ms:resetTiming[10],scope:'Child CLI, one exact reset packet, >=450 ms peer-verified settling, query and 2000 ms discovery window. Isolated vcan; no physical device or Python timing comparison.'}}));
 const s=samples.slice(5).sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,warmup:5,runs:11,imageBytes:4093,medianMs:s[5],p95Ms:s[10],scope:'Complete child Katapult CAN CLI: file preflight, targeted reboot, 1000 ms wait, assignment + 500 ms wait, identity, write/readback and exit on isolated vcan. No physical bus/flash or Python full-CLI comparison.'}));
 console.log('PASS: real CAN CLI flash/status/request/query and SIGTERM cancellation');
 }finally{rmSync(directory,{recursive:true,force:true});}
}
if(process.argv[2]==='--inside')await inside(process.argv[3],process.argv[4]);else{
 const temporary=mkdtempSync(resolve(tmpdir(),'katapult-cli-vcan-'));try{const peer=resolve(temporary,'bridge'),query=resolve(temporary,'query');for(const [source,target] of [['katapult-can-bridge.c',peer],['can-query-peer.c',query]])command(process.env.CC??'cc',['-O2','-Wall','-Wextra','-Werror',resolve(host,'test/fixtures',source),'-o',target]);const r=spawnSync('unshare',['--user','--map-root-user','--net','env',`LD_PRELOAD=${process.env.LD_PRELOAD??''}`,`ASAN_OPTIONS=${process.env.ASAN_OPTIONS??''}`,process.execPath,script,'--inside',peer,query],{env:{...env(),KATAPULT_PARENT_NET:readlinkSync('/proc/self/ns/net'),KATAPULT_PARENT_USER:readlinkSync('/proc/self/ns/user')},stdio:'inherit',timeout:90000});assert.equal(r.status,0,String(r.error||r.signal));}finally{rmSync(temporary,{recursive:true,force:true});}
}
