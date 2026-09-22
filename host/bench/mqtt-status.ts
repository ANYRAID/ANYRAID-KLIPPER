import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {MqttStatusPublisher} from '../src/moonraker/mqtt-status.ts';
import {prepareStatus} from '../src/moonraker/subscription-status.ts';
import {mqttStatusOracle} from '../test/helpers/mqtt-status-oracle.ts';
const count=10000,rounds=9;
const value={toolhead:{position:[10.123456789,20,30,4],velocity:150},extruder:{temperature:215.125,target:220},print_stats:{state:'printing',print_duration:12345.5}};
const input=prepareStatus(value),results:any[]=[];
for(const split of [false,true]){
 const times:number[]=[];
 for(let round=0;round<rounds;round++){
  let frames=0;const publisher=new MqttStatusPublisher({async publish(_topic,payload){assert.ok(payload.length);frames++;}},'printer',{objects:{toolhead:null,extruder:null,print_stats:null},split,interval:0},()=>true);
  const start=performance.now();for(let i=0;i<count;i++){publisher.send(input,i/1000);while(publisher.status.active)await Promise.resolve();}const elapsed=performance.now()-start;
  assert.equal(frames,count*(split?6:1));assert.equal(publisher.status.failed,0);assert.equal(publisher.status.rejected,0);await publisher.close();if(round>=2)times.push(elapsed);
 }
 results.push({split,node:times});
}
const py=spawnSync('python3',['-c',mqttStatusOracle()+`\nvalue=json.loads(${JSON.stringify(JSON.stringify(value))})\nresults=[]\nfor split in [False,True]:\n times=[]\n for r in range(${rounds}):\n  obj=reference(split,0,False);start=time.perf_counter()\n  for i in range(${count}):obj.send_status(value,i/1000)\n  elapsed=(time.perf_counter()-start)*1000\n  assert obj.count==${count}*(6 if split else 1)\n  if r>=2:times.append(elapsed)\n results.append(times)\nprint(json.dumps(results))`],{encoding:'utf8'});assert.equal(py.status,0,py.stderr);
const samples=JSON.parse(py.stdout);const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {median:sorted[3],p95:sorted[6]};};console.log(JSON.stringify({node:process.version,updates:count,rounds:7,warmup:2,results:results.map((r,i)=>({split:r.split,node:stats(r.node),python:stats(samples[i])}))},null,2));
