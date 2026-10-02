import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,cpus} from 'node:os';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MoveQueueScheduler} from '../src/motion/move-queue.ts';
const root=fileURLToPath(new URL('../../',import.meta.url)),dir=mkdtempSync(join(tmpdir(),'anyraid-move-queue-'));
const fixtures=[1,2,17,128,1024].map((slots,k)=>{const base=k===4?2n**60n:0n,rows:string[][]=[];
 for(let i=0;i<8000;i++){const request=base+BigInt(i%97===0?Math.max(0,i-100):i)*20n;rows.push([String(i%8),String(i%7===0?0n:request+100n),String(request),String(i)]);}
 return {slots,rows,clocks:[base+20000n,base+80000n,base+200000n].map(String)};});
const source=readFileSync(join(root,'klippy/chelper/steppersync.c'),'utf8');const start=source.indexOf('static void\nheap_replace'),end=source.indexOf('/****************************************************************',start);assert(start>=0&&end>start);
const c=String.raw`
#include <stdlib.h>
#include <stdint.h>
#include <stddef.h>
#include "serialqueue.h"
struct syncemitter {struct list_node ss_node;struct list_head msg_queue;};
struct steppersync {struct list_head se_list;uint64_t *move_clocks;int num_move_clocks;struct serialqueue *sq;struct command_queue *cq;};
struct capture {uint64_t *out;int n,stage;};
void serialqueue_send_batch(struct serialqueue *sq,struct command_queue *cq,struct list_head *msgs){
 struct capture *c=(void*)sq;
 while(!list_empty(msgs)){struct queue_message *m=list_first_entry(msgs,struct queue_message,node);list_del(&m->node);uint64_t *r=c->out+c->n++*4;r[0]=m->notify_id;r[1]=m->min_clock;r[2]=m->req_clock;r[3]=c->stage;}
}
`+source.slice(start,end)+String.raw`
int oracle(int slots,int n,uint64_t *rows,int stages,uint64_t *clocks,uint64_t *out){
 struct capture cap={.out=out};struct steppersync ss={.num_move_clocks=slots,.sq=(void*)&cap};list_init(&ss.se_list);ss.move_clocks=calloc(slots,sizeof(uint64_t));
 struct syncemitter emitters[8];for(int i=0;i<8;i++){list_init(&emitters[i].msg_queue);list_add_tail(&emitters[i].ss_node,&ss.se_list);}
 struct queue_message *msgs=calloc(n,sizeof(*msgs));
 for(int i=0;i<n;i++){msgs[i].min_clock=rows[4*i+1];msgs[i].req_clock=rows[4*i+2];msgs[i].notify_id=rows[4*i+3];list_add_tail(&msgs[i].node,&emitters[rows[4*i]].msg_queue);}
 for(int i=0;i<stages;i++){cap.stage=i;steppersync_flush(&ss,clocks[i]);}
 free(msgs);free(ss.move_clocks);return cap.n;
}
`;
const python=String.raw`
import cffi,json,sys,time
ffi=cffi.FFI();ffi.cdef('int oracle(int,int,uint64_t *,int,uint64_t *,uint64_t *);');lib=ffi.dlopen(sys.argv[1]);fixtures=json.load(open(sys.argv[2]))
def run(f):
 rows=ffi.new('uint64_t[]',[int(x) for row in f['rows'] for x in row]);clocks=ffi.new('uint64_t[]',[int(x) for x in f['clocks']]);out=ffi.new('uint64_t[]',len(f['rows'])*4)
 n=lib.oracle(f['slots'],len(f['rows']),rows,len(f['clocks']),clocks,out)
 return [str(out[i]) for i in range(n*4)]
results=[run(f) for f in fixtures]
for _ in range(20):run(fixtures[0])
times=[]
for _ in range(31):
 t=time.perf_counter();run(fixtures[0]);times.append((time.perf_counter()-t)*1000)
print(json.dumps({'results':results,'times':sorted(times)}))
`;
try{
 const file=join(dir,'oracle.c'),lib=join(dir,'oracle.so'),input=join(dir,'fixtures.json');writeFileSync(file,c);writeFileSync(input,JSON.stringify(fixtures));
 const cc=spawnSync(process.env.CC??'cc',['-O2','-shared','-fPIC','-I'+join(root,'klippy/chelper'),file,'-o',lib],{encoding:'utf8'});assert.equal(cc.status,0,cc.stderr);
 const py=spawnSync(process.env.PYTHON??'python3',['-c',python,lib,input],{encoding:'utf8',maxBuffer:32*1024*1024,timeout:60000});assert.equal(py.status,0,py.stderr);const oracle=JSON.parse(py.stdout);
 function run(f:typeof fixtures[number]){const s=new MoveQueueScheduler(Array.from({length:8},(_,i)=>String(i)),f.slots);const outputs=Array.from({length:8},(_,i)=>({id:String(i),messages:[] as {data:Buffer;minClock:bigint;reqClock:bigint}[]}));
  for(const [emitter,min,req,id] of f.rows){const data=Buffer.allocUnsafe(4);data.writeUInt32LE(Number(id));outputs[Number(emitter)].messages.push({data,minClock:BigInt(min),reqClock:BigInt(req)});}s.append(outputs);
  const result:string[]=[];f.clocks.forEach((clock,stage)=>{for(const p of s.flush(BigInt(clock)))result.push(String(p.data.readUInt32LE()),String(p.minClock),String(p.reqClock),String(stage));});assert.equal(s.pending,0);return result;
 }
 fixtures.forEach((f,i)=>assert.deepEqual(run(f),oracle.results[i]));for(let i=0;i<20;i++)run(fixtures[0]);const times=[];for(let i=0;i<31;i++){const t=performance.now();run(fixtures[0]);times.push(performance.now()-t);}times.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:fixtures.length,messages:8000,exact:true,nodeMedianMs:times[15],nodeP95Ms:times[29],pythonCffiMedianMs:oracle.times[15],pythonCffiP95Ms:oracle.times[29],speedup:oracle.times[15]/times[15]},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
