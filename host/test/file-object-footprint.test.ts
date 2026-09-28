import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
import {readFileObjectFootprint} from '../src/gcode/file-object-footprint.ts';
const signal=new AbortController().signal;
async function fixture(text:string){const dir=await mkdtemp('/tmp/footprint-'),path=dir+'/job.gcode';await writeFile(path,text);const reader=await GCodeFileReader.adopt(await open(path,'r'),{chunkBytes:11,batchLines:1});return {reader,path,async close(){await reader.close();await rm(dir,{recursive:true,force:true});}};}
const definition='EXCLUDE_OBJECT_DEFINE NAME=part POLYGON=[[1,2],[3,2],[3,4],[1,4]]\n';
test('authorized footprint parses quoted definitions without dispatching and retains earlier reset coverage',async()=>{
 const f=await fixture(definition+'G1 X999 E100\nEXCLUDE_OBJECT_DEFINE RESET=1\nEXCLUDE_OBJECT_DEFINE NAME="new part" POLYGON="[[10,10],[11,10],[11,11]]"\nEXCLUDE_OBJECT_START NAME="new part"\n');try{const result=await readFileObjectFootprint(f.reader,signal);assert(result.complete);assert.equal(result.polygons.length,2);assert.equal(result.identity.size,String(f.reader.status.size));assert.match(result.digest,/^[0-9a-f]{64}$/);assert(f.reader.status.eof);await assert.rejects(readFileObjectFootprint(f.reader,signal),/fresh/);}finally{await f.close();}
});
test('normalized identity digest is independent of batching and CRLF while source identity remains distinct',async()=>{
 const a=await fixture(definition),b=await fixture(definition.replaceAll('\n','\r\n'));try{const x=await readFileObjectFootprint(a.reader,signal),y=await readFileObjectFootprint(b.reader,signal);assert.equal(x.digest,y.digest);assert.notDeepEqual(x.identity,y.identity);}finally{await a.close();await b.close();}
});
test('incomplete object geometry falls back to full coverage and malformed geometry rejects',async()=>{
 for(const text of ['G1 X1\n',definition+'EXCLUDE_OBJECT_START NAME=unknown\n',definition+'EXCLUDE_OBJECT_DEFINE NAME=missing\n']){const f=await fixture(text);try{const r=await readFileObjectFootprint(f.reader,signal);assert.equal(r.complete,false);assert.deepEqual(r.polygons,[]);}finally{await f.close();}}
 const f=await fixture('EXCLUDE_OBJECT_DEFINE NAME=x POLYGON=[[0,0],[1e999,0],[1,1]]\n');try{await assert.rejects(readFileObjectFootprint(f.reader,signal),/polygon/);}finally{await f.close();}
});
test('source mutation and cancellation do not return a usable footprint',async()=>{
 const f=await fixture(definition);try{await writeFile(f.path,definition+'G1 X1\n');await assert.rejects(readFileObjectFootprint(f.reader,signal),/changed/);}finally{await f.close();}
 const g=await fixture(definition),abort=new AbortController();abort.abort(Error('cancelled'));try{await assert.rejects(readFileObjectFootprint(g.reader,abort.signal),/cancelled/);}finally{await g.close();}
});
