// GPL-3.0-or-later. One read-only bed_mesh/dump_mesh request, no replay.
import {stat} from 'node:fs/promises';
import {createConnection,type Socket} from 'node:net';
import WebSocket from 'ws';
import {ConsoleFrames} from './webhook-console.ts';
import {readMeshDump} from './mesh-file.ts';
import {parseRequestJson} from '../moonraker/json.ts';
const request='{"id":1,"method":"bed_mesh/dump_mesh"}';
export function meshSocketUrl(input:string):string{
 const url=new URL(input);if(!['http:','https:','ws:','wss:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error('Invalid mesh source URL');url.protocol=url.protocol.replace('http','ws');if(!url.pathname.endsWith('/klippysocket'))url.pathname=url.pathname.replace(/\/+$/,'')+'/klippysocket';return url.href;
}
export async function requestMeshDump(source:string,signal:AbortSignal,options:{timeoutMs?:number;maxBytes?:number}={}):Promise<unknown>{
 const timeout=options.timeoutMs??20000,max=options.maxBytes??64*1024**2;if(!Number.isInteger(timeout)||timeout<1||timeout>600000||!Number.isSafeInteger(max)||max<1||max>64*1024**2)throw new RangeError('Invalid mesh acquisition limit');signal.throwIfAborted();
 const remote=/^[a-z][a-z\d+.-]*:\/\//i.test(source);let url:string|undefined;if(remote)url=meshSocketUrl(source);else{const info=await stat(source);signal.throwIfAborted();if(!info.isSocket())return readMeshDump(source,signal,max);}
 return new Promise((resolve,reject)=>{let finished=false,bytes=0,socket:Socket|undefined,ws:WebSocket|undefined;const frames=new ConsoleFrames(3,max),timer=setTimeout(()=>finish(new Error('Mesh dump request timed out')),timeout);
  const finish=(error?:unknown,result?:unknown)=>{if(finished)return;finished=true;clearTimeout(timer);signal.removeEventListener('abort',abort);socket?.destroy();ws?.terminate();if(error)reject(error);else resolve(result);};
  const abort=()=>finish(signal.reason??new Error('Mesh acquisition cancelled'));
  const consume=(frame:Buffer)=>{if(finished)return;const value=parseRequestJson(new TextDecoder('utf-8',{fatal:true}).decode(frame));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid mesh response');const obj=value as Record<string,unknown>;if(obj.id!==1)return;if(Object.hasOwn(obj,'error')){const err=obj.error;throw new Error('Error requesting mesh dump: '+(err&&typeof err==='object'&&'message' in err&&typeof err.message==='string'?err.message:'Unknown'));}if(!Object.hasOwn(obj,'result')||!obj.result||typeof obj.result!=='object'||Array.isArray(obj.result))throw new Error('Missing mesh result object');finish(undefined,obj.result);};
  const receive=(chunk:Buffer,framed:boolean)=>{if(finished)return;try{bytes+=chunk.length;if(bytes>max)throw new RangeError('Mesh response byte limit exceeded');if(framed)for(const frame of frames.push(chunk))consume(frame);else consume(chunk);}catch(error){finish(error);}};
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted){abort();return;}
  try{if(url){ws=new WebSocket(url,{maxPayload:max,perMessageDeflate:false,followRedirects:false,handshakeTimeout:timeout});ws.on('error',error=>finish(error));ws.on('close',()=>finish(new Error('WebSocket closed before mesh received')));ws.on('open',()=>{if(!finished)ws!.send(request,error=>{if(error)finish(error);});});ws.on('message',(data,binary)=>{if(binary){finish(new Error('Expected text mesh response'));return;}receive(Array.isArray(data)?Buffer.concat(data):Buffer.from(data as Buffer),false);});}else{socket=createConnection({path:source});socket.on('error',error=>finish(error));socket.on('close',()=>finish(new Error('Socket closed before mesh received')));socket.on('connect',()=>{if(!finished)socket!.write(request+'\x03',error=>{if(error)finish(error);});});socket.on('data',chunk=>receive(Buffer.from(chunk),true));}}catch(error){finish(error);}
 });
}
