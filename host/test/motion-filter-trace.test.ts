import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {traceMotionFilter} from '../scripts/motion-filter-trace.ts';
import {filterMotion} from '../src/diagnostics/motion-filters.ts';
const original=new URL('../src/diagnostics/motion-filters.ts',import.meta.url);
test('filter boundary capture refuses an unreviewed source before producing instrumentation',async()=>{
 const source=await readFile(original,'utf8');
 assert.throws(()=>traceMotionFilter(source+'\n'),/reviewed source fingerprint/);
 assert.throws(()=>traceMotionFilter(source.replace('high=next','high=value')),/reviewed source fingerprint/);
});
test('private boundary capture records single-read operands and compensated state without changing binary64 outputs',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'motion-filter-boundary-'));
 try{
  const source=await readFile(original,'utf8'),path=join(directory,'filter.ts');
  await writeFile(path,traceMotionFilter(source),{flag:'wx'});
  const observed=await import(pathToFileURL(path).href);
  const data=Array.from({length:9500},(_,i)=>((i%31)-15)/8);
  const before=[...data],expected=filterMotion(data,'weighted4');
  const actual=observed.filterMotion(data,'weighted4');
  assert.deepEqual(actual,expected);
  const calls=observed.drainFilterTrace();
  assert.equal(calls.length,1);assert.deepEqual(calls[0].inputBefore,before);assert.deepEqual(calls[0].inputAfter,before);
  assert.deepEqual(calls[0].points.map((p:{index:number})=>p.index),[4398,4399,7855,7856,8661,8662]);
  for(const point of calls[0].points){
   assert.equal(point.n,83);assert.equal(point.steps.length,166);
   let high=0,low=0;
   for(const row of point.steps){
    assert.equal(row.sample,data[row.index]);assert.equal(row.highBefore,high);assert.equal(row.lowBefore,low);
    high=row.high;low=row.low;assert.equal(row.next,high);
   }
   assert.equal(point.sum,high+low);assert.equal(point.output,actual[point.index]);
  }
  assert.deepEqual(observed.drainFilterTrace(),[]);
  observed.filterMotion(data,'average');assert.deepEqual(observed.drainFilterTrace(),[]);
  assert.equal(await readFile(original,'utf8'),source);
 }finally{await rm(directory,{recursive:true,force:true});}
});
