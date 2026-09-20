import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PrintSnapshotBudget} from '../src/gcode/snapshot-budget.ts';
import {createSealedPrintReader} from '../src/gcode/sealed-file.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex'),signal=()=>new AbortController().signal;
async function fixture(){const directory=await mkdtemp(join(tmpdir(),'snapshot-budget-')),path=join(directory,'file');await writeFile(path,'G1 X1\n');const source=await open(path,'r');return {source,async close(){await source.close();await rm(directory,{recursive:true,force:true});}};}
test('quota is page-rounded, synchronous and idempotently released, including empty snapshots',()=>{
 const page=new PrintSnapshotBudget().status.pageBytes,budget=new PrintSnapshotBudget({maxBytes:page*2,maxSnapshots:2});assert.ok(Number.isSafeInteger(page)&&page>0);
 const first=budget.reserve(1),second=budget.reserve(page);assert.equal(budget.status.reservedBytes,page*2);assert.throws(()=>budget.reserve(0),/quota/);first.release();first.release();assert.equal(budget.status.reservedBytes,page);const empty=budget.reserve(0);assert.equal(budget.status.reservations,2);second.release();empty.release();assert.equal(budget.status.reservations,0);
});
test('budget remains charged through EOF until the snapshot descriptor closes',async()=>{
 const f=await fixture(),page=new PrintSnapshotBudget().status.pageBytes,budget=new PrintSnapshotBudget({maxBytes:page,maxSnapshots:1});
 try{const first=await createSealedPrintReader(f.source,sha('G1 X1\n'),signal(),{budget});const batch=(await first.reader.next(signal()))!;first.reader.commit(batch);await first.reader.next(signal());assert.equal(budget.status.reservedBytes,page);await assert.rejects(createSealedPrintReader(f.source,sha('G1 X1\n'),signal(),{budget}),/quota/);await first.reader.close();assert.equal(budget.status.reservations,0);const second=await createSealedPrintReader(f.source,sha('G1 X1\n'),signal(),{budget});await second.reader.close();}finally{await f.close();}
});
test('an in-flight copy reserves capacity before another request can enter',async()=>{
 const f=await fixture(),budget=new PrintSnapshotBudget({maxSnapshots:1}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
 const source={stat:()=>f.source.stat({bigint:true}),read:async(buffer:Buffer,offset:number,length:number,position:number)=>{entered.resolve();await release.promise;return f.source.read(buffer,offset,length,position);}} as unknown as import('node:fs/promises').FileHandle;
 try{const copying=createSealedPrintReader(source,sha('G1 X1\n'),signal(),{budget});await entered.promise;assert.equal(budget.status.reservations,1);await assert.rejects(createSealedPrintReader(f.source,sha('G1 X1\n'),signal(),{budget}),/quota/);release.resolve();const snapshot=await copying;await snapshot.reader.close();assert.equal(budget.status.reservedBytes,0);}finally{release.resolve();await f.close();}
});
test('digest failure releases capacity after cleanup',async()=>{
 const f=await fixture(),budget=new PrintSnapshotBudget({maxSnapshots:1});try{await assert.rejects(createSealedPrintReader(f.source,sha('wrong'),signal(),{budget}),/digest/);assert.equal(budget.status.reservations,0);assert.equal(budget.status.reservedBytes,0);}finally{await f.close();}
});
test('reader close observer runs once after actual descriptor close, never on failed close',async()=>{
 const f=await fixture();let closed=0,observed=0;const gate=Promise.withResolvers<void>();
 try{const fake={stat:()=>f.source.stat({bigint:true}),close:async()=>{await gate.promise;closed++;}} as unknown as import('node:fs/promises').FileHandle;const reader=await GCodeFileReader.adopt(fake,{onClosed:()=>{assert.equal(closed,1);observed++;}});const close=reader.close();assert.equal(close,reader.close());assert.equal(observed,0);gate.resolve();await close;assert.equal(observed,1);
 const broken={stat:fake.stat,close:async()=>{throw new Error('close failed');}} as unknown as import('node:fs/promises').FileHandle;const bad=await GCodeFileReader.adopt(broken,{onClosed:()=>{observed++;}});await assert.rejects(bad.close(),/close failed/);assert.equal(observed,1);
 }finally{await f.close();}
});
