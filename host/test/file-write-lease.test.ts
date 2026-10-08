import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {FileWriteLease} from '../src/moonraker/file-write-lease.ts';
test('a fully written archive stays busy until the actual writer closes; read lease preserves borrowed position',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'write-lease-')),path=join(dir,'source'),writer=await open(path,'wx'),signal=new AbortController().signal;let lease:FileWriteLease|undefined;await writer.writeFile('complete archive');const source=await open(path,'r');
 try{assert.equal(await FileWriteLease.acquire(source,signal),undefined);await writer.close();await source.read(Buffer.alloc(3),0,3,null);lease=await FileWriteLease.acquire(source,signal);assert(lease);await lease.check();const next=Buffer.alloc(1);await source.read(next,0,1,null);assert.equal(next.toString(),'p');await lease.close();assert.equal((await source.stat()).size,16);await writeFile(path,'replacement');}finally{await lease?.close();if(writer.fd>=0)await writer.close();await source.close();await rm(dir,{recursive:true,force:true});}
});
test('reopening a leased archive for writing aborts the import proof and unblocks the writer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'write-lease-break-')),path=join(dir,'source');await writeFile(path,'closed archive');const source=await open(path,'r');let lease:FileWriteLease|undefined;
 try{lease=await FileWriteLease.acquire(source,new AbortController().signal);assert(lease);const aborted=once(lease.signal,'abort'),writer=open(path,'w');await aborted;const handle=await writer;await handle.writeFile('changed');await handle.close();assert.match(String(lease.signal.reason),/writing|exited/);await assert.rejects(lease.check());await lease.close();assert.equal((await source.stat()).size,7);}finally{await lease?.close();await source.close();await rm(dir,{recursive:true,force:true});}
});
test('cancelling the owner kills and joins its separate lease process before returning',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'write-lease-cancel-')),path=join(dir,'source');await writeFile(path,'closed archive');const source=await open(path,'r'),owner=new AbortController();let lease:FileWriteLease|undefined;
 try{lease=await FileWriteLease.acquire(source,owner.signal);assert(lease);const cause=new Error('Controlled lease owner cancellation');owner.abort(cause);assert.equal(lease.signal.reason,cause);await lease.close();const writer=await open(path,'w');await writer.close();assert((await source.stat()).isFile());}finally{await lease?.close();await source.close();await rm(dir,{recursive:true,force:true});}
});
