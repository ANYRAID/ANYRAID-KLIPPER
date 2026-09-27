import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMotanJson,encodeMotanJson} from '../src/motan/capture.ts';
test('wide clock parsing preserves integers, float bits and numeric-looking strings',()=>{
 const raw=Buffer.from('{"clock":9007199254740993,"backward":-9007199254740993,"safe":9007199254740991,"float":9007199254740993.0,"zero":-0.0,"text":"[9007199254740993]","escaped":"\\\"clock\\\":9007199254740993"}');
 const value=parseMotanJson(raw) as Record<string,unknown>;assert.equal(value.clock,9007199254740993n);assert.equal(value.backward,-9007199254740993n);assert.equal(value.safe,9007199254740991);assert.equal(value.float,9007199254740992);assert(Object.is(value.zero,-0));assert.equal(value.text,'[9007199254740993]');assert.equal(value.escaped,'"clock":9007199254740993');
 // Default mode preserves values, not float token spelling on reserialization.
 assert.deepEqual(parseMotanJson(encodeMotanJson(value)),{...value,float:9007199254740992n});
 assert.equal(parseMotanJson(Buffer.from('9007199254740993')),9007199254740993n);
 for(const source of ['{"x":1e999}','{"clock":9007199254740993,"x":1e999}','{"clock":09007199254740993}','{"clock":9007199254740993,}'])assert.throws(()=>parseMotanJson(Buffer.from(source)));
 assert.throws(()=>parseMotanJson(Buffer.from('{"clock":'+('9'.repeat(4301))+'}'),true),/digit limit/);
 const status=parseMotanJson(Buffer.from('{"q":"status","params":{"status":{"s":{"clock":9007199254740993,"float":1.0,"zero":-0.0}}}}'),true);
 assert.match(encodeMotanJson(status).toString(),/"float":1\.0,"zero":-0\.0/);
});
