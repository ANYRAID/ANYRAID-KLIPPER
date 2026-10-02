// GPL-3.0-or-later. Motan Unix socket capture owner.
import {createConnection,type Socket} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {parseArgs} from 'node:util';
import {setPriority,getPriority} from 'node:os';
import {MotanLogWriter} from './log-writer.ts';
import {MotanCapture,encodeMotanJson} from './capture.ts';
import {motanPattern} from './subscriptions.ts';
import {ConsoleFrames} from '../diagnostics/webhook-console.ts';
export async function captureMotan(path:string,prefix:string,patterns:readonly string[],signal:AbortSignal,output:(text:string)=>void,options:{connectTimeoutMs?:number;requestTimeoutMs?:number}={}):Promise<void>{
 const connectTimeout=options.connectTimeoutMs??10000,requestTimeout=options.requestTimeoutMs??30000;for(const n of [connectTimeout,requestTimeout])if(!Number.isInteger(n)||n<1||n>600000)throw new Error('Invalid Motan timeout');if(patterns.length>64)throw new Error('Too many Motan patterns');patterns.forEach(motanPattern);signal.throwIfAborted();
 let socket:Socket|undefined,log:MotanLogWriter|undefined,index:MotanLogWriter|undefined,timer:ReturnType<typeof setInterval>|undefined;const failures:unknown[]=[];
 const abort=()=>socket?.destroy(signal.reason instanceof Error?signal.reason:new Error('Motan capture cancelled'));
 signal.addEventListener('abort',abort,{once:true});
 try{output(`Waiting for connect to ${path}\n`);const until=performance.now()+connectTimeout;
  for(;;){signal.throwIfAborted();const connection=createConnection({path});socket=connection;connection.on('error',()=>{});try{await new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>connection.destroy(new Error('Motan connect timed out')),Math.max(1,until-performance.now()));const clean=()=>{clearTimeout(timeout);connection.off('connect',ready);connection.off('error',failed);},ready=()=>{clean();resolve();},failed=(error:Error)=>{clean();reject(error);};connection.once('connect',ready);connection.once('error',failed);});break;}catch(error){connection.destroy();if((error as NodeJS.ErrnoException).code!=='ECONNREFUSED'||performance.now()>=until)throw error;await delay(100,undefined,{signal});}}
  output('Connection.\n');signal.throwIfAborted();log=await MotanLogWriter.open(prefix+'.json.gz');index=await MotanLogWriter.open(prefix+'.index.gz');let deadline=performance.now()+requestTimeout;
  const send=async(message:Record<string,unknown>)=>{signal.throwIfAborted();deadline=performance.now()+requestTimeout;const bytes=Buffer.concat([encodeMotanJson(message),Buffer.from([3])]);if(bytes.length>1024*1024)throw new Error('Motan outgoing request limit exceeded');await new Promise<void>((resolve,reject)=>socket!.write(bytes,error=>error?reject(error):resolve()));};
  const capture=new MotanCapture({log,index},send,patterns,output),frames=new ConsoleFrames(3);timer=setInterval(()=>{if(capture.status.pendingRequests&&performance.now()>deadline)socket!.destroy(new Error('Motan subscription response timed out'));},Math.min(1000,requestTimeout));
  await capture.start();for await(const chunk of socket){signal.throwIfAborted();await capture.accept(frames.push(Buffer.from(chunk)));if(capture.status.ended)break;}
  if(!capture.status.ended&&(frames.pending||capture.status.pendingRequests))throw new Error('Motan socket closed with incomplete data or requests');signal.throwIfAborted();output('Socket closed\n');
 }catch(error){failures.push(error);}finally{clearInterval(timer);signal.removeEventListener('abort',abort);socket?.destroy();const closed=await Promise.allSettled([log?.close(),index?.close()]);for(const result of closed)if(result.status==='rejected')failures.push(result.reason);}
 if(failures.length===1)throw failures[0];if(failures.length)throw new AggregateError(failures,'Motan capture and cleanup failed');
}
export async function runMotanLogger(args:readonly string[],signal:AbortSignal,output:(text:string)=>void):Promise<void>{
 const {values,positionals}=parseArgs({args:[...args],allowPositionals:true,options:{subscribe:{type:'string',short:'s'},'no-default':{type:'boolean'},help:{type:'boolean',short:'h'}}});
 if(values.help){output('Usage: node scripts/motan/data_logger.ts [-s patterns] [--no-default] <socket filename> <log name>\n');return;}if(positionals.length!==2)throw new Error('Expected socket filename and log name');const patterns=[...values['no-default']?[]:['trapq:*','stepq:*'],...(values.subscribe??'').split(',').map(s=>s.trim())];
 try{setPriority(0,Math.min(19,getPriority(0)+10));}catch{/* Optional scheduling courtesy, not a correctness requirement. */}
 await captureMotan(positionals[0],positionals[1],patterns,signal,output);
}
