import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import {deflateSync} from 'node:zlib';
import assert from 'node:assert/strict';
import {downloadIdentify} from '../src/protocol/identify.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
import {JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
const raw={commands:{'get_clock':2},responses:{'clock clock=%u':3},version:'benchmark',config:Object.fromEntries(Array.from({length:500},(_,i)=>['constant_'+i,i]))};
const compressed=deflateSync(JSON.stringify(raw)),bootstrap=new MessageDictionary();
async function identifyBatch():Promise<void> {
  for(let i=0;i<100;i++) {
    const result=await downloadIdentify(async(payload,signal)=>{
      signal.throwIfAborted();
      const params=bootstrap.parseFrame(encodeFrame(0,payload))[0].parameters;
      const offset=params.offset as number;
      return {name:'identify_response',parameters:{offset,data:compressed.subarray(offset,offset+40)}};
    });
    assert.equal(result.version,'benchmark');assert.equal(result.constant('constant_499'),499);
  }
}
const rpc=new JsonRpcDispatcher(),ctx={transport:'websocket' as const,signal:new AbortController().signal,authorize:()=>{}};
rpc.register('echo',['websocket'],params=>params);
const request='{"jsonrpc":"2.0","method":"echo","params":{"value":123,"enabled":true},"id":7}';
async function rpcBatch():Promise<void> {
  for(let i=0;i<10000;i++) {
    const response=await rpc.dispatch(request,ctx);
    assert.equal(JSON.parse(response!).result.value,123);
  }
}
const report:Record<string,unknown>={node:process.version,cpu:cpus()[0].model,identifyCompressedBytes:compressed.length};
for(const [name,batch,count] of [['identify',identifyBatch,100],['rpc',rpcBatch,10000]] as const) {
  for(let i=0;i<3;i++) await batch();
  const samples=[];
  for(let i=0;i<11;i++) {const start=performance.now();await batch();samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);
  report[name]={operations:count,medianMs:samples[5],p95Ms:samples[10],medianPerOperationMs:samples[5]/count};
}
console.log(JSON.stringify(report,null,2));
