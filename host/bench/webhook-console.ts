import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
import {ConsoleFrames,consoleRequest} from '../src/diagnostics/webhook-console.ts';
const input=Buffer.from(Array.from({length:10000},(_,i)=>JSON.stringify({id:i,method:'objects/query',params:{objects:{toolhead:['position']}}})).join('\n')+'\n');
const source=String.raw`
import sys,runpy,io,time,hashlib,json
m=runpy.run_path(sys.argv[1]);data=sys.stdin.buffer.read();samples=[];stdout=sys.stdout
class Socket:
 def __init__(self):self.frames=[]
 def send(self,data):self.frames.append(data);return len(data)
for run in range(16):
 sock=Socket();obj=m['KeyboardReader'].__new__(m['KeyboardReader']);obj.kbd_fd=0;obj.kbd_data=b'';obj.webhook_socket=sock;chunks=iter([data[i:i+4096] for i in range(0,len(data),4096)]);m['os'].read=lambda *args:next(chunks);sys.stdout=io.StringIO();start=time.perf_counter()
 for _ in range((len(data)+4095)//4096):obj.process_kbd()
 samples.append((time.perf_counter()-start)*1000)
sys.stdout=stdout
print(json.dumps(dict(python=sys.version.split()[0],samples=samples[5:],count=len(sock.frames),sha256=hashlib.sha256(b''.join(sock.frames)).hexdigest())))
`;
const ref=JSON.parse(execFileSync(process.env.PYTHON??'python3',['-c',source,fileURLToPath(new URL('../../scripts/whconsole.py',import.meta.url))],{input,encoding:'utf8'}));const samples:number[]=[];let frames:string[]=[];for(let run=0;run<16;run++){const framer=new ConsoleFrames(10);frames=[];let printed='';const at=performance.now();for(let offset=0;offset<input.length;offset+=4096)for(const line of framer.push(input.subarray(offset,offset+4096))){const value=consoleRequest(line);if(value!==undefined){printed+=`SEND: ${value}\n`;frames.push(value+'\x03');}}if(run>=5)samples.push(performance.now()-at);assert.ok(printed.length>input.length);}assert.equal(frames.length,ref.count);assert.equal(createHash('sha256').update(frames.join('')).digest('hex'),ref.sha256);const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};};console.log(JSON.stringify({node:process.version,python:ref.python,requests:10000,inputBytes:input.length,warmups:5,runs:11,nodeFraming:stats(samples),pythonFraming:stats(ref.samples),wireSha256:ref.sha256,scope:'Input framing, JSON validation/compaction, SEND formatting and output accumulation in memory. Original KeyboardReader.process_kbd with os.read/socket/stdout substitutes. Actual socket/terminal backpressure and startup excluded.'},null,2));
