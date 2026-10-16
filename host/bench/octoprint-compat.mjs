import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {OctoprintCompatibility} from '../src/moonraker/octoprint-compat.ts';
const bytes=readFileSync(new URL('../contracts/octoprint-compat-reference.json',import.meta.url)),reference=JSON.parse(bytes),results=[],loop=monitorEventLoopDelay({resolution:1});loop.enable();if(createHash('sha256').update(bytes).digest('hex')!=='d894cd77b6bc8fc39de9437497d59792850455c319515bbbe7318543abc37335')throw Error('Frozen OctoPrint reference changed');
const context={transport:'http',signal:new AbortController().signal,authorize(){return {username:'operator'};}};
for(const row of reference.benchmarks){
 const reader=new ConfigurationReader(new ConfigurationSource('/synthetic/octoprint',{server:{},octoprint_compat:{}},[])),component=new OctoprintCompatibility(reader,'node-test',{state:()=>row.input.state,query:async objects=>Object.hasOwn(objects,'heaters')?{heaters:{available_sensors:Object.keys(row.input.heaters)},print_stats:{state:row.input.printState}}:row.input.heaters,async command(){},async select(){}}),expected=JSON.stringify(row.expected);
 const batch=async()=>{let output;for(let i=0;i<row.iterations;i++)output=await component.handle(row.path,{},context);if(JSON.stringify(output)!==expected)throw Error('Pinned OctoPrint output mismatch');};
 for(let i=0;i<row.warmups;i++)await batch();const sampleMs=[];for(let i=0;i<row.samples;i++){const start=performance.now();await batch();sampleMs.push(performance.now()-start);}
 const medianMs=[...sampleMs].sort((a,b)=>a-b)[Math.floor(sampleMs.length/2)],ratio=medianMs/row.medianMs;results.push({...row,input:undefined,expected:undefined,sampleMs,medianMs,referenceMedianMs:row.medianMs,ratio,pass:ratio<=row.maximumMedianRatio});
}
await new Promise(resolve=>setTimeout(resolve,5));loop.disable();console.log(JSON.stringify({node:process.version,referenceSha256:createHash('sha256').update(bytes).digest('hex'),results,pass:results.every(r=>r.pass),loopP99Ms:loop.percentile(99)/1e6,loopMaxMs:loop.max/1e6,scope:'Fixed cached-method desktop cost; no Python execution, target-board, thermal or print-throughput proof.'},null,2));if(results.some(r=>!r.pass))process.exitCode=1;
