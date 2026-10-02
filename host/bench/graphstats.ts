import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {parseStats,mcuStatsPlot,systemStatsPlot,frequencyStatsPlot,temperatureStatsPlot} from '../src/diagnostics/graphstats.ts';
import {graphstatsFixture,graphstatsReference,graphstatsManifest} from './graphstats-reference.ts';
const text=graphstatsFixture(10000),reference=graphstatsReference(text),node:number[]=[],stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
for(let run=0;run<16;run++){
 const at=performance.now(),data=parseStats(text),plots=[mcuStatsPlot(data),systemStatsPlot(data),frequencyStatsPlot(data),frequencyStatsPlot(data,'mcu'),temperatureStatsPlot(data,'heater, absent')],elapsed=performance.now()-at;
 assert.deepEqual(JSON.parse(JSON.stringify(data)),reference.samples);
 for(let i=0;i<plots.length;i++){
  const expected=reference.plots[i],actual=plots[i];
  assert.equal(actual.title,expected.title);assert.deepEqual(actual.axes,expected.axes);assert.equal(actual.curves.length,expected.curves.length);
  for(let j=0;j<actual.curves.length;j++){
   const a=actual.curves[j],b=expected.curves[j];
   assert.equal(a.label,b.label);assert.equal(a.axis,b.axis);assert.equal(a.style,b.style);
   assert.deepEqual(a.values,b.values);assert.deepEqual(a.times,b.times);
  }
 }
 if(run>=5)node.push(elapsed);
}
console.log(JSON.stringify({node:process.version,samples:10000,inputBytes:Buffer.byteLength(text),warmups:5,runs:11,nodeParseAndFivePlots:stats(node),historicalPythonParseAndFivePlots:graphstatsManifest.before.pythonParseAndFivePlots,nodeBeforeRetirement:graphstatsManifest.before.nodeParseAndFivePlots,scope:'In-memory diagnostic parsing and five plot models. All samples and complete curves checked against hash-verified original Python captures outside timers. Python timing is historical, not rerun. No rendering, process startup or printer throughput claim.'},null,2));
