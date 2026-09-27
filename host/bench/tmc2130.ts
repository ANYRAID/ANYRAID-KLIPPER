import {readFileSync} from 'node:fs';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc2130} from '../src/drivers/tmc2130.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc2130-reference.json',import.meta.url),'utf8')),samples:number[]=[];
const readers=reference.rows.map((r:any)=>new ConfigurationReader(new ConfigurationSource('/bench.cfg',{'tmc2130 stepper_x':r.driver,stepper_x:r.stepper},[]),null));let registers=0;
for(let batch=0;batch<9;batch++){const start=performance.now();for(const reader of readers)registers+=planTmc2130(reader,'tmc2130 stepper_x').registers.length;if(batch>=2)samples.push(performance.now()-start);}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,plans:readers.length,warmups:2,batches:7,registers,medianMs:samples[3],maxMs:samples[6],pythonMs:reference.historicalPythonMs,scope:'Node validated configuration plans versus original Python constructor with mocked config getters; no SPI I/O'},null,2));
