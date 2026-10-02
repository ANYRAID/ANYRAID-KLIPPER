import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,open,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {registerSaveConfig} from '../src/config/klipper-save-command.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
async function fixture(run:(path:string,s:KlipperSaveSession,d:GCodeDispatch,events:string[])=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'save-emergency-')),path=join(dir,'printer.cfg'),events:string[]=[];try{await writeFile(path,'[x]\na: old\n');const {session}=await KlipperSaveSession.load(path),dispatch=new GCodeDispatch({output(message){events.push(message);},shutdown(reason){events.push('stop:'+reason);}});dispatch.setReady(true);session.apply([{kind:'set',section:'x',option:'a',value:'new'}]);await run(path,session,dispatch,events);}finally{await rm(dir,{recursive:true,force:true});}}
for(const boundary of [1,2])test(`emergency at directory sync ${boundary} prevents restart and invalidates queued motion`,async t=>fixture(async(path,s,d,events)=>{
 let restarts=0,moves=0;registerSaveConfig(d,s,()=>{restarts++;});d.register('G1',()=>{moves++;});const f=await open(path,'r'),prototype=Object.getPrototypeOf(f) as FileHandle;await f.close();const original=prototype.sync;let directories=0;
 const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if((await this.stat()).isDirectory()&&++directories===boundary)d.emergencyStop('injected emergency');return original.call(this);});
 try{
  const saving=d.execute('SAVE_CONFIG\nG1 X1',{acknowledge:true}),queued=d.execute('G1 X2');
  // Observe both rejections immediately; queued rejection must not be unhandled.
  const results=await Promise.allSettled([saving,queued]);assert.equal(results[0].status,'rejected');assert.equal(results[1].status,'rejected');assert.equal(restarts,0);assert.equal(moves,0);assert.equal(events.filter(e=>e==='stop:injected emergency').length,1);assert.equal(events.includes('ok'),false);
  assert.equal(s.status.sealedForRestart,false);
  if(boundary===1){assert.equal(await readFile(path,'utf8'),'[x]\na: old\n');assert.equal(s.status.state,'failed');assert.equal(s.status.save_config_pending,true);assert.equal(s.status.restartRequired,false);}
  else{assert.match(await readFile(path,'utf8'),/a = new/);assert.equal(s.status.state,'saved');assert.equal(s.status.save_config_pending,false);assert.equal(s.status.restartRequired,true);}
  await assert.rejects(d.execute('G1 X3'),/injected emergency/);
 }finally{mock.mock.restore();}
}));
test('emergency during asynchronous restart request aborts its signal and retains sealed committed state',async()=>fixture(async(path,s,d,events)=>{
 let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});let restartSignal:AbortSignal|undefined,moves=0;
 registerSaveConfig(d,s,signal=>new Promise<void>((_resolve,reject)=>{restartSignal=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});enter();}));d.register('G1',()=>{moves++;});
 const saving=d.execute('SAVE_CONFIG\nG1 X1',{acknowledge:true});const result=Promise.allSettled([saving]);await entered;d.emergencyStop('restart emergency');assert.equal((await result)[0].status,'rejected');assert.equal(restartSignal!.aborted,true);assert.equal(moves,0);assert.equal(events.includes('ok'),false);assert.equal(events.filter(e=>e==='stop:restart emergency').length,1);assert.match(await readFile(path,'utf8'),/a = new/);assert.equal(s.status.sealedForRestart,true);assert.equal(s.status.restartRequired,true);assert.equal(s.status.state,'saved');assert.throws(()=>s.apply([{kind:'set',section:'x',option:'a',value:'late'}]),/sealed/);
}));
