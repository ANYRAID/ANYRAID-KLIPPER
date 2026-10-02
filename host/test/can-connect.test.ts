import test from 'node:test';
import assert from 'node:assert/strict';
import {canIdentity,connectCAN} from '../src/protocol/can.ts';
test('CAN identity accepts exact six-byte range and preserves leading zeros',()=>{
 assert.deepEqual(canIdentity('1'),{uuid:Buffer.from('000000000001','hex'),nodeId:64,clientId:384});
 assert.equal(canIdentity('0xFFFFFFFFFFFF',255).uuid.toString('hex'),'ffffffffffff');assert.equal(canIdentity('0',0).clientId,256);
 for(const uuid of ['', '-1','gg','1000000000000',' 123','0x','1_2'])assert.throws(()=>canIdentity(uuid),/Invalid/);
 for(const id of [-1,256,1.5,NaN])assert.throws(()=>canIdentity('11aa22bb33cc',id),/Invalid/);
});
test('CAN connection rejects cancellation and invalid options before opening or assigning',async()=>{
 let stopped=0;const options={async stopDevice(){stopped++;}},control=new AbortController();control.abort(new Error('cancel before connect'));
 await assert.rejects(connectCAN('can0','11aa22bb33cc',options,control.signal),/cancel before connect/);
 for(const changed of [{timeoutMs:0},{timeoutMs:60001},{nodeId:256},{canClientId:384}])await assert.rejects(connectCAN('can0','11aa22bb33cc',{...options,...changed},new AbortController().signal),/Invalid/);
 await assert.rejects(connectCAN('../bad','11aa22bb33cc',options,new AbortController().signal),/Invalid/);assert.equal(stopped,0);
});
