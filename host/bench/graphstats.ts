import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {parseStats,mcuStatsPlot,systemStatsPlot,frequencyStatsPlot,temperatureStatsPlot} from '../src/diagnostics/graphstats.ts';
import {graphstatsFixture,graphstatsReference} from './graphstats-reference.ts';
const text=graphstatsFixture(10000),node:number[]=[],python:number[]=[],stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
for(let run=0;run<16;run++){
 const at=performance.now(),data=parseStats(text),plots=[mcuStatsPlot(data),systemStatsPlot(data),frequencyStatsPlot(data),frequencyStatsPlot(data,'mcu'),temperatureStatsPlot(data,'heater, absent')],elapsed=performance.now()-at,reference=graphstatsReference(text,undefined,true);
 for(let i=0;i<plots.length;i++){const expected=reference.plots[i] as any;assert.equal(plots[i].curves.length,expected.curves.length);for(let j=0;j<plots[i].curves.length;j++)assert.deepEqual(plots[i].curves[j].values,expected.curves[j].values);}
 if(run>=5){node.push(elapsed);python.push(reference.elapsedMs);}
}
console.log(JSON.stringify({node:process.version,samples:10000,inputBytes:Buffer.byteLength(text),warmups:5,runs:11,nodeParseAndFivePlots:stats(node),pythonParseAndFivePlots:stats(python),scope:'Diagnostic calculations only: original Python parser and five original plot functions with a recording Matplotlib stub; Node typed plot models. Both begin with decoded input text; original Python open is adapted to StringIO. Process startup, JSON transfer, rendering and GUI excluded. All curve values compared each run. This is not a renderer benchmark or target-board print timing guarantee.'},null,2));
