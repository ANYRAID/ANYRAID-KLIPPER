import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeStateReference,stateReference} from './helpers/moonraker-state-reference.ts';
const bytes=readFileSync(new URL('../contracts/moonraker-state-python-reference.json.gz',import.meta.url));
test('state reference binds all original captured inputs and independent outputs',()=>{
 const data=decodeStateReference(bytes);
 for(const c of data.captures)assert.deepEqual(stateReference(c.id,c.input,c.id.endsWith('bench-0')?100000:undefined,c.id.endsWith('bench-0')?11:undefined),JSON.parse(c.stdout));
});
test('state reference rejects corrupt, truncated and oversized compressed data',()=>{
 const corrupt=Buffer.from(bytes);corrupt[corrupt.length>>1]^=1;
 for(const data of [corrupt,bytes.subarray(0,bytes.length-1),Buffer.concat([bytes,Buffer.from([0])])])assert.throws(()=>decodeStateReference(data),/fingerprint/);
});
test('state reference rejects unknown profiles and changed original input',()=>{
 const data=decodeStateReference(bytes);
 for(const c of data.captures)assert.throws(()=>stateReference(c.id,c.input+' '),/Uncaptured/);
 assert.throws(()=>stateReference('job-bench-0','',99999,11),/Uncaptured/);
 assert.throws(()=>stateReference('job-bench-0','',100000,10),/Uncaptured/);
 assert.throws(()=>stateReference('gcode-bench-0','',100000,11),/Uncaptured/);
 assert.throws(()=>stateReference('unknown' as 'job-test-0',''),/Uncaptured/);
 const job=data.captures.find(c=>c.id==='job-test-1')!;
 const changed=JSON.parse(job.input);changed[0].initial.info.current_layer=0;
 assert.throws(()=>stateReference(job.id,JSON.stringify(changed)),/Uncaptured/);
 const gcode=data.captures.find(c=>c.id==='gcode-test-0')!;
 const messages=JSON.parse(gcode.input);messages[0].entries[0].message+=' ';
 assert.throws(()=>stateReference(gcode.id,JSON.stringify(messages)),/Uncaptured/);
});
