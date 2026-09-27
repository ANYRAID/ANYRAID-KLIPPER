import {performance} from 'node:perf_hooks';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc220x} from '../src/drivers/tmc220x.ts';
import {Tmc220xCurrent} from '../src/drivers/tmc220x-current.ts';
const plan=planTmc220x(new ConfigurationReader(new ConfigurationSource('/bench.cfg',{'tmc2209 stepper_x':{run_current:'.4'},stepper_x:{microsteps:'16',rotation_distance:'40'}},[]),null),'tmc2209 stepper_x');
const samples:number[]=[],signal=new AbortController().signal;let writes=0;
const owner=new Tmc220xCurrent({async write(){writes++;}},plan,signal,()=>{throw new Error('Unexpected fault');});
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<10000;i++)await owner.set({run:i%2?.4:1.5},signal);const elapsed=performance.now()-start;if(batch>=2)samples.push(elapsed);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,updates:10000,warmups:2,batches:7,medianMs:samples[3],maxMs:samples[6],writes,scope:'Current quantization, cancellation and publication; immediately acknowledged mock writes, excludes drain and UART'},null,2));
