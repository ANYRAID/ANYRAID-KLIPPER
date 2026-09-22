import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import {ApiError,JsonRpcDispatcher} from '../src/moonraker/rpc.ts';
import {MqttRpc} from '../src/moonraker/mqtt-rpc.ts';
const frame=(id:number,params:unknown={},method='printer.test')=>Buffer.from(JSON.stringify({jsonrpc:'2.0',id,method,params}));
test('MQTT RPC authorizes stripped parameters and screens duplicates across frames and batches',async()=>{
 const rpc=new JsonRpcDispatcher(),responses:any[]=[],seen:any[]=[];rpc.register('printer.test',['mqtt'],(params,context)=>{seen.push({params,user:context.user});return params;});
 const api=new MqttRpc(rpc,{async publish(topic,payload){assert.equal(topic,'p/moonraker/api/response');responses.push(JSON.parse(payload));}},'p',(_method,params)=>{assert.equal(Object.hasOwn(params,'mqtt_timestamp'),false);return {username:'broker-user'};});const signal=new AbortController().signal;
 for(const id of [1,2]){api.receive(frame(id,{mqtt_timestamp:42,x:2.675}),false,signal);await turn();}
 assert.equal(seen.length,1);assert.equal(seen[0].user.username,'broker-user');assert.deepEqual(responses[0].result,{x:2.675});assert.equal(responses[1].error.code,-10000);
 api.receive(Buffer.from(JSON.stringify([{jsonrpc:'2.0',method:'printer.test',params:{mqtt_timestamp:'batch'}},{jsonrpc:'2.0',id:3,method:'printer.test',params:{mqtt_timestamp:'batch'}}])),false,signal);await turn();assert.equal(seen.length,2);assert.equal(responses.at(-1)[0].error.code,-10000);await api.close();
});
test('MQTT RPC rejects retained commands and bounded overload; disconnect cancels responses',async()=>{
 const rpc=new JsonRpcDispatcher();let calls=0,responses=0;const releases:(()=>void)[]=[];
 rpc.register('printer.test',['mqtt'],async()=>{calls++;await new Promise<void>(r=>releases.push(r));return 'done';});const generation=new AbortController();
 const api=new MqttRpc(rpc,{async publish(){responses++;}},'p',()=>{});
 api.receive(frame(0),true,generation.signal);api.receive(Buffer.alloc(65537),false,generation.signal);
 for(let i=0;i<17;i++)api.receive(frame(i),false,generation.signal);await turn();assert.equal(calls,16);assert.equal(api.status.rejected,3);assert.equal(api.status.pending,16);
 generation.abort();for(const release of releases)release();await turn();assert.equal(responses,0);assert.equal(api.status.failed,16);await api.close();
});
test('MQTT RPC authorization failures do not consume timestamps and callbacks track response handoff',async()=>{
 const rpc=new JsonRpcDispatcher();let allowed=false,calls=0;const responses:any[]=[],handoffs:boolean[]=[];
 rpc.register('printer.test',['mqtt'],(_params,ctx)=>{calls++;ctx.afterResponse?.(sent=>handoffs.push(sent));return 'ok';});rpc.register('http.only',['http'],()=>{throw new Error('must not run');});
 const api=new MqttRpc(rpc,{async publish(_topic,payload){responses.push(JSON.parse(payload));}},'p',()=>{if(!allowed)throw new ApiError(401,'Denied');});const signal=new AbortController().signal;
 api.receive(frame(1,{mqtt_timestamp:'retry'}),false,signal);await turn();assert.equal(calls,0);allowed=true;
 api.receive(frame(2,{mqtt_timestamp:'retry'}),false,signal);await turn();assert.equal(calls,1);assert.deepEqual(handoffs,[true]);
 api.receive(frame(3,{},'http.only'),false,signal);api.receive(Buffer.from('{'),false,signal);api.receive(frame(4,{mqtt_timestamp:[]}),false,signal);await turn();assert.deepEqual(responses.slice(-3).map(r=>r.error.code).sort((a,b)=>a-b),[-32700,-32601,400]);await api.close();
});
test('MQTT timestamp window matches the executed pinned upstream screening method',async()=>{
 const {readFileSync}=await import('node:fs'),{createHash}=await import('node:crypto'),{spawnSync}=await import('node:child_process');
 const contract=JSON.parse(readFileSync(new URL('../contracts/moonraker-mqtt.json',import.meta.url),'utf8'));assert.equal(createHash('sha256').update(contract.source).digest('hex'),contract.sourceSha256);
 const timestamps=[0,0,...Array.from({length:20},(_,i)=>i+1),0];
 const code=`import ast,json,types,logging\nfrom collections import deque\nfrom typing import Dict,Any\nAPIDefinition=RequestType=object\nDUP_API_REQ_CODE=-10000\nsource=${JSON.stringify(contract.source)}\ncls=next(n for n in ast.parse(source).body if isinstance(n,ast.ClassDef) and n.name=='MQTTClient')\nmethod=next(n for n in cls.body if isinstance(n,ast.FunctionDef) and n.name=='screen_rpc_request')\nexec(compile(ast.fix_missing_locations(ast.Module(body=[method],type_ignores=[])),'mqtt.py','exec'))\nowner=types.SimpleNamespace(timestamp_deque=deque(maxlen=20),server=types.SimpleNamespace(error=lambda message,code:ValueError(code)))\nresults=[]\nfor i,stamp in enumerate(${JSON.stringify(timestamps)}):\n args=dict(mqtt_timestamp=stamp,value=i)\n try:\n  screen_rpc_request(owner,None,None,args);results.append(dict(result=args))\n except ValueError as e:results.append(dict(code=e.args[0]))\nprint(json.dumps(results))`;
 const child=spawnSync('python3',['-c',code],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);const expected=JSON.parse(child.stdout),actual:any[]=[],rpc=new JsonRpcDispatcher();rpc.register('printer.test',['mqtt'],params=>params);
 const api=new MqttRpc(rpc,{async publish(_topic,payload){const reply=JSON.parse(payload);actual.push(reply.error?{code:reply.error.code}:{result:reply.result});}},'p',()=>{}),signal=new AbortController().signal;
 for(let i=0;i<timestamps.length;i++){api.receive(frame(i,{mqtt_timestamp:timestamps[i],value:i}),false,signal);await turn();}assert.deepEqual(actual,expected);await api.close();
});
