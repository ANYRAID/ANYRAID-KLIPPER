import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,open,rm,type FileHandle} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {KlipperSaveCommitError} from '../src/config/klipper-save-commit.ts';
import {loadKlipperConfiguration} from '../src/config/klipper-files.ts';
async function fixture(run:(path:string,current:string,prototype:FileHandle)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'save-session-')),path=join(dir,'printer.cfg'),current='[x]\na: original\n';try{await writeFile(path,current);const f=await open(path,'r'),prototype=Object.getPrototypeOf(f) as FileHandle;await f.close();await run(path,current,prototype);}finally{await rm(dir,{recursive:true,force:true});}}
const update=(value:string)=>[{kind:'set' as const,section:'x',option:'a',value}];
test('save session rejects overlapping saves, retains in-flight changes and saves them against committed text',async t=>fixture(async(path,current,prototype)=>{
 const s=new KlipperSaveSession(path,current);s.apply(update('first'));const original=prototype.sync;let injected=false;
 const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if(!injected){injected=true;s.apply(update('second'));}return original.call(this);});
 try{const running=s.save();assert.equal(s.status.state,'saving');await assert.rejects(s.save(),/already in progress/);const result=await running;assert.equal(result!.pending,true);assert.equal(s.status.restartRequired,true);assert.equal((await loadKlipperConfiguration(path)).original.x.a,'first');assert.equal(await readFile(result!.backupPath,'utf8'),current);
 const second=await s.save();assert.equal(second!.pending,false);assert.equal(s.status.state,'saved');assert.equal((await loadKlipperConfiguration(path)).original.x.a,'second');assert.equal(s.status.save_config_pending,false);
 }finally{mock.mock.restore();}
}));
test('preparation failure and cancellation preserve pending values and allow a later explicit retry',async()=>fixture(async(path,current)=>{
 const s=new KlipperSaveSession(path,current);s.apply(update('new'));await writeFile(path,current+'# external edit\n');await assert.rejects(s.save(),/changed/);assert.equal(s.status.state,'failed');assert.equal(s.status.save_config_pending,true);assert.equal(s.status.restartRequired,false);
 await writeFile(path,current);const c=new AbortController(),cause=new Error('cancel');c.abort(cause);await assert.rejects(s.save(c.signal),e=>e===cause);assert.equal(s.status.error,cause);assert.equal(await readFile(path,'utf8'),current);await s.save();assert.equal(s.status.error,undefined);assert.equal(s.status.save_config_pending,false);
}));
test('post-rename failure latches recovery state and never acknowledges pending values or silently retries',async t=>fixture(async(path,current,prototype)=>{
 const s=new KlipperSaveSession(path,current);s.apply(update('new'));const original=prototype.sync;let dirs=0;
 const mock=t.mock.method(prototype,'sync',async function(this:FileHandle){if((await this.stat()).isDirectory()&&++dirs===2)throw new Error('post-rename sync');return original.call(this);});
 try{await assert.rejects(s.save(),e=>e instanceof KlipperSaveCommitError&&e.phase==='replaced');assert.equal(s.status.state,'recovery-required');assert.equal(s.status.save_config_pending,true);assert.equal((await loadKlipperConfiguration(path)).original.x.a,'new');const error=s.status.error;await assert.rejects(s.save(),/recovery and reload/);assert.equal(s.status.error,error);}finally{mock.mock.restore();}
}));
test('empty saved sections retain original no-write behavior without claiming activation',async()=>fixture(async(path,current)=>{const s=new KlipperSaveSession(path,current,{x:{a:'old'}});s.apply([{kind:'remove',section:'x'}]);assert.equal(await s.save(),null);assert.equal(s.status.state,'idle');assert.equal(s.status.save_config_pending,true);assert.equal(s.status.restartRequired,false);assert.equal(await readFile(path,'utf8'),current);}));
