import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {cpus,tmpdir} from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {NativeSerialQueue} from '../src/protocol/serial-queue.ts';
import {serialPair} from '../test/helpers/serial-pair.ts';
const count=2000,times:number[]=[],payload=Uint8Array.of(3,1,2),future=1000000000000n;
for(let run=0;run<14;run++){const p=await serialPair(),q=new NativeSerialQueue(p.fd);try{const start=performance.now();for(let i=0;i<count;i++)q.send(payload,future,future);if(run>=3)times.push(performance.now()-start);}finally{q.close();await p.close();}}
times.sort((a,b)=>a-b);const dir=mkdtempSync(join(tmpdir(),'anyraid-serial-bench-')),root=fileURLToPath(new URL('../../klippy/chelper/',import.meta.url));
try{const library=join(dir,'serialqueue.so');const compile=spawnSync(process.env.CC??'cc',['-shared','-fPIC','-O2','-pthread',...['serialqueue.c','msgblock.c','pollreactor.c','pyhelper.c'].map(p=>join(root,p)),'-lm','-o',library],{encoding:'utf8',timeout:60000});assert.equal(compile.status,0,compile.stderr);
 const python=String.raw`
import cffi,socket,time,sys,json
ffi=cffi.FFI();ffi.cdef('''struct serialqueue; struct command_queue;
struct serialqueue *serialqueue_alloc(int,char,int,char*);
void serialqueue_exit(struct serialqueue*);void serialqueue_free(struct serialqueue*);
struct command_queue *serialqueue_alloc_commandqueue(void);void serialqueue_free_commandqueue(struct command_queue*);
void serialqueue_send(struct serialqueue*,struct command_queue*,uint8_t*,int,uint64_t,uint64_t,uint64_t);''')
lib=ffi.dlopen(sys.argv[1]);times=[];payload=ffi.new('uint8_t[]',[3,1,2]);name=ffi.new('char[16]',b'python-bench')
for run in range(14):
 a,b=socket.socketpair();q=lib.serialqueue_alloc(a.fileno(),b'u',0,name);cq=lib.serialqueue_alloc_commandqueue()
 try:
  begin=time.perf_counter()
  for i in range(2000):lib.serialqueue_send(q,cq,payload,3,1000000000000,1000000000000,i+1)
  if run>=3:times.append((time.perf_counter()-begin)*1000)
 finally:lib.serialqueue_exit(q);lib.serialqueue_free(q);lib.serialqueue_free_commandqueue(cq);a.close();b.close()
print(json.dumps({'samples':sorted(times),'python':sys.version.split()[0]}))
`;
 const result=spawnSync(process.env.PYTHON??'python3',['-c',python,library],{encoding:'utf8',env:{...process.env,PYTHONPATH:process.env.PYTHONPATH??'/tmp/anyraid-host-oracle/packages'},timeout:60000});assert.equal(result.status,0,result.stderr);const ref=JSON.parse(result.stdout);
 console.log(JSON.stringify({node:process.version,python:ref.python,cpu:cpus()[0].model,messages:count,nodeMedianMs:times[5],nodeP95Ms:times[10],pythonMedianMs:ref.samples[5],pythonP95Ms:ref.samples[10],scope:'Enqueue into native future-clock queues; includes Node validation/BigInt/notification IDs. No ACK, line throughput, target-board latency or hardware stop claim.'},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
