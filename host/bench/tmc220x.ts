import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc220x} from '../src/drivers/tmc220x.ts';
const ref=JSON.parse(readFileSync(new URL('../contracts/tmc220x-reference.json',import.meta.url),'utf8')),samples:number[]=[];
for(let run=0;run<27;run++){
 const readers=ref.rows.map((r:any)=>new ConfigurationReader(new ConfigurationSource('/tmc.cfg',{[r.model+' stepper_x']:r.driver,stepper_x:r.stepper},[]),null));
 const start=performance.now(),plans=readers.map((reader:ConfigurationReader,i:number)=>planTmc220x(reader,ref.rows[i].model+' stepper_x'));if(run>=20)samples.push(performance.now()-start);
 plans.forEach((p:any,i:number)=>assert.deepEqual(p.registers,ref.rows[i].registers));
}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({scope:'256 startup plans with configuration parsing, excludes source construction/I/O; Node 20 warmups/7 measured',node:process.version,nodeMs:{median:samples[3],p95:samples[6]},historicalPythonMs:{median:ref.historicalPythonMs[3],p95:ref.historicalPythonMs[6]},limitation:'Python mock configuration getters do less validation than Node; no claim of equal workloads or physical print throughput'}));
