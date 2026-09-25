import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
import {NativeSubscriptions} from '../src/moonraker/native-subscriptions.ts';
import {trajectory} from '../test/helpers/motion-stream.ts';
const clients=16,iterations=2000,python=String.raw`
import ast,contextlib,json,sys,time,types
text=open(sys.argv[1]).read();SUBSCRIPTION_REFRESH_TIME=.25
node=next(n for n in ast.parse(text).body if isinstance(n,ast.ClassDef) and n.name=='QueryStatusHelper');exec(ast.get_source_segment(text,node),globals())
state=0;clients=16;iterations=2000;checksum=0;messages=[]
def data():return {'position':[state*.001,2.675,1e-9,0],'temperature':200+state*.001,'target':210,'power':.5,'flag':True}
reactor=types.SimpleNamespace(assert_no_pause=contextlib.nullcontext,unregister_timer=lambda t:None,NEVER=float('inf'))
printer=types.SimpleNamespace(get_reactor=lambda:reactor,lookup_object=lambda name,default=None:types.SimpleNamespace(get_status=lambda t:data()))
helper=QueryStatusHelper.__new__(QueryStatusHelper);helper.printer=printer;helper.last_query={};helper.clients={};helper.query_timer=None;helper.pending_queries=[]
class Client:
 def is_closed(self):return False
def send(message):
 global checksum
 checksum+=len(json.dumps(message['params'],separators=(',',':')))
 if 0<state<=3:messages.append(message['params'])
for i in range(clients):
 c=Client();helper.clients[c]=(c,{'object'+str(j):None for j in range(7)},send,{})
helper._do_query(0)
times=[]
for sample in range(14):
 start=time.perf_counter()
 for i in range(iterations):state+=1;helper._do_query(state*.25)
 if sample>=3:times.append((time.perf_counter()-start)*1e6/iterations)
print(json.dumps({'times':sorted(times),'checksum':checksum,'messages':messages}))
`;
const oracle=spawnSync(process.env.PYTHON??'python3',['-c',python,fileURLToPath(new URL('../../klippy/webhooks.py',import.meta.url))],{encoding:'utf8',timeout:60000});if(oracle.status!==0)throw Error(oracle.stderr||String(oracle.error));const reference=JSON.parse(oracle.stdout);
const messages:unknown[]=[];let state=0,checksum=0,calls=0;const data=()=>{calls++;return {position:[state*.001,2.675,1e-9,0],temperature:200+state*.001,target:210,power:.5,flag:true};},objects=new NativeObjects(new Map(Array.from({length:7},(_,j)=>['object'+j,data])),()=>state*.25),owner=new NativeSubscriptions(objects,{deliver:(_id,status,eventtime)=>{checksum+=JSON.stringify({eventtime,status}).length;if(state<=3)messages.push({eventtime,status});},disconnect:()=>assert.fail('Sampling failed')});
const filters=Object.fromEntries(objects.list().objects.map(name=>[name,null]));for(let id=1;id<=clients;id++)await owner.subscribe(id,filters);
const times:number[]=[];for(let sample=0;sample<14;sample++){const start=performance.now();for(let i=0;i<iterations;i++){state++;owner.sample();}if(sample>=3)times.push((performance.now()-start)*1000/iterations);}times.sort((a,b)=>a-b);owner.close();assert.deepEqual(JSON.parse(JSON.stringify(messages)),reference.messages);assert.equal(calls,clients*7+14*iterations*7);
const limits={medianRatio:1.5,medianSlackUs:50,p95Ratio:2,p95SlackUs:100};
const sampling={python:{medianUs:reference.times[5],p95Us:reference.times[10]},node:{medianUs:times[5],p95Us:times[10]},clients,objects:7,iterations,warmup:3,samples:11,limits,checksum};console.log(JSON.stringify({sampling}));assert(times[5]<=reference.times[5]*limits.medianRatio+limits.medianSlackUs);assert(times[10]<=reference.times[10]*limits.p95Ratio+limits.p95SlackUs);
// Interleave a synchronous 16-client sample every ten native trajectory runs.
// This is a controlled CPU-load comparison, not real transport/hardware timing.
const motionTimes:number[][]=[[],[]];let comparedSteps=0;
for(let round=0;round<14;round++)for(const loaded of round%2?[true,false]:[false,true]){
 const load=new NativeSubscriptions(objects,{deliver:(_id,status,time)=>{checksum+=JSON.stringify([status,time]).length;},disconnect:()=>assert.fail()});if(loaded)for(let id=1;id<=clients;id++)await load.subscribe(id,filters);
 const start=performance.now();try{for(let i=0;i<100;i++){if(loaded&&i%10===0){state++;load.sample();}const result=await trajectory(i%2,true,round===0);if(round===0){const baseline=await trajectory(i%2,false);assert.equal(result.position,baseline.position);assert.equal(result.ticks.length,baseline.ticks.length);for(let j=0;j<result.ticks.length;j++){assert.equal(result.ticks[j].position,baseline.ticks[j].position);assert(result.ticks[j].clock-baseline.ticks[j].clock<=1n&&baseline.ticks[j].clock-result.ticks[j].clock<=1n);}comparedSteps+=result.ticks.length;}}}finally{load.close();}
 if(round>=3)motionTimes[Number(loaded)].push(performance.now()-start);
}
for(const times of motionTimes)times.sort((a,b)=>a-b);const motion=motionTimes.map(times=>({medianMs:times[5],p95Ms:times[10]})),motionLimits={medianRatio:1.15,p95Ratio:1.25,slackMs:5};console.log(JSON.stringify({node:process.version,motion,variants:['baseline','16ClientSamples'],motionLimits,comparedSteps,scope:'100 native rolling trajectory generations per sample; ten interleaved subscription sampling cycles. Excludes physical printing, UART and network authorization/encoding queues.'}));assert(motion[1].medianMs<=motion[0].medianMs*motionLimits.medianRatio+motionLimits.slackMs);assert(motion[1].p95Ms<=motion[0].p95Ms*motionLimits.p95Ratio+motionLimits.slackMs);
