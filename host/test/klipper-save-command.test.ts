import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,open,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {registerSaveConfig} from '../src/config/klipper-save-command.ts';
import {GCodeDispatch,GCodeError} from '../src/gcode/dispatch.ts';
async function fixture(run:(path:string,s:KlipperSaveSession,d:GCodeDispatch)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'save-command-')),path=join(dir,'printer.cfg');try{await writeFile(path,'[x]\na: old\n');const {session}=await KlipperSaveSession.load(path),dispatch=new GCodeDispatch({output(){},shutdown(){throw new Error('Unexpected dispatcher shutdown');}});dispatch.setReady(true);await run(path,session,dispatch);}finally{await rm(dir,{recursive:true,force:true});}}
const update=(value:string)=>[{kind:'set' as const,section:'x',option:'a',value}];
test('SAVE_CONFIG requests restart only after disk commit and stops following script commands',async()=>fixture(async(path,s,d)=>{
 s.apply(update('new'));let restarts=0,moves=0;d.register('G1',()=>{moves++;});registerSaveConfig(d,s,async()=>{restarts++;assert.match(await readFile(path,'utf8'),/a = new/);assert.equal(s.status.sealedForRestart,true);assert.throws(()=>s.apply(update('late')),/sealed/);});
 await assert.rejects(d.execute('SAVE_CONFIG\nG1 X1'),/restart required/);assert.equal(restarts,1);assert.equal(moves,0);assert.equal(s.status.save_config_pending,false);await assert.rejects(s.save(),/sealed/);
}));
test('no saved sections is a no-op and a precommit failure never requests restart',async()=>fixture(async(path,s,d)=>{
 let restarts=0;registerSaveConfig(d,s,()=>{restarts++;});await d.execute('SAVE_CONFIG');assert.equal(restarts,0);s.apply(update('new'));await writeFile(path,'[x]\na: external\n');await assert.rejects(d.execute('SAVE_CONFIG'),e=>e instanceof GCodeError&&e.cause instanceof Error);assert.equal(restarts,0);assert.equal(s.status.save_config_pending,true);assert.equal(s.status.sealedForRestart,false);
}));
test('new values during SAVE_CONFIG remain pending and prevent restart',async t=>fixture(async(path,s,d)=>{
 s.apply(update('first'));let restarts=0;registerSaveConfig(d,s,()=>{restarts++;});const f=await open(path,'r'),prototype=Object.getPrototypeOf(f) as FileHandle;await f.close();const original=prototype.sync;let once=false;
 const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if(!once){once=true;s.apply(update('second'));}return original.call(this);});
 try{await assert.rejects(d.execute('SAVE_CONFIG'),/newer changes remain pending/);assert.equal(restarts,0);assert.equal(s.status.sealedForRestart,false);assert.equal(s.status.save_config_pending,true);await d.execute('SAVE_CONFIG');assert.equal(restarts,1);}finally{mock.mock.restore();}
}));
test('restart failure preserves committed state and sealed session without allowing subsequent motion',async()=>fixture(async(path,s,d)=>{
 s.apply(update('new'));const cause=new Error('restart failed');registerSaveConfig(d,s,()=>{throw cause;});await assert.rejects(d.execute('SAVE_CONFIG'),e=>e instanceof GCodeError&&e.cause===cause);assert.match(await readFile(path,'utf8'),/a = new/);assert.equal(s.status.state,'saved');assert.equal(s.status.sealedForRestart,true);assert.equal(s.status.restartRequired,true);await assert.rejects(d.execute('G1 X1'),/restart required/);
}));
test('uncertain durable save blocks later commands without requesting restart',async t=>fixture(async(path,s,d)=>{
 s.apply(update('new'));let restarts=0;registerSaveConfig(d,s,()=>{restarts++;});const f=await open(path,'r'),prototype=Object.getPrototypeOf(f) as FileHandle;await f.close();const original=prototype.sync;let dirs=0;
 const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if((await this.stat()).isDirectory()&&++dirs===2)throw new Error('sync failed');return original.call(this);});
 try{await assert.rejects(d.execute('SAVE_CONFIG'),/SAVE_CONFIG failed/);assert.equal(restarts,0);assert.equal(s.status.state,'recovery-required');await assert.rejects(d.execute('G1 X1'),/requires recovery/);}finally{mock.mock.restore();}
}));
