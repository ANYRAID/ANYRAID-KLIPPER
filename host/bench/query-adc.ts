import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {QueryADC} from '../src/inputs/query-adc.ts';
import {queryADCOracle} from '../test/helpers/query-adc-oracle.ts';
const count=100000,query=new QueryADC();query.register('bed',{lastValue:[123.1875,.375]});
const samples:number[]=[];
for(let run=0;run<13;run++){
 const start=performance.now();let result='';for(let i=0;i<count;i++)result=query.report('bed','4700');
 const elapsed=performance.now()-start;assert.equal(result,'ADC object "bed" has value 0.375000 (timestamp 123.188)\n resistance 2820.000 (with 4700 pullup)');
 if(run>=2)samples.push(elapsed);
}
const oracle=queryADCOracle();
const python=spawnSync('/usr/bin/python3',['-c',oracle.slice(0,oracle.indexOf('query=QueryADC.__new__'))+`
import time
query=QueryADC.__new__(QueryADC)
query.adc={'bed':Sample([123.1875,.375])}
command=Command({'NAME':'bed','PULLUP':'4700'})
times=[]
for run in range(13):
 start=time.perf_counter()
 for i in range(${count}): query.cmd_QUERY_ADC(command)
 elapsed=(time.perf_counter()-start)*1000
 if run>=2: times.append(elapsed)
assert command.result=='ADC object "bed" has value 0.375000 (timestamp 123.188)\\n resistance 2820.000 (with 4700 pullup)'
print(json.dumps(times))
`],{encoding:'utf8'});
assert.equal(python.status,0,python.stderr);
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};};
console.log(JSON.stringify({node:process.version,pythonRevision:'6950d00f',warmups:2,samples:11,reports:count,nodeResult:stats(samples),pythonResult:stats(JSON.parse(python.stdout)),scope:'Read and format registered ADC value plus resistance; excludes dispatch, serial IO and process startup.'},null,2));
