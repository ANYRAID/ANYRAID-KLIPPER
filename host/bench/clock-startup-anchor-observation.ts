import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ClockSync,type ClockSample,type ClockEstimate,type ReleaseEstimate} from '../src/timing/clock-sync.ts';
type StoredEstimate=Omit<ClockEstimate,'origin'>&{origin:string};
type StoredRelease=Omit<ReleaseEstimate,'clock'>&{clock:string};
type Row={sample:ClockSample;warmup:boolean;revision:number;before:StoredEstimate;after:StoredEstimate;release:StoredRelease|null};
type Evidence={status:string;captured:{samples:{initial:{frequency:number;uptimeClock:string;sentTime:number};warmup:Row[];recent:Row[]}};expected:{counterfactual:{name:string;anchorRevision:number;periodicAccepted:number;periodicRejected:number}[]}};
const evidence:Evidence=JSON.parse(await readFile(new URL('../contracts/clock-startup-anchor-observation.json',import.meta.url),'utf8'));
const capture=evidence.captured.samples,warm=capture.warmup,initial=capture.initial,all=[...warm,...capture.recent];
const decode=(value:StoredEstimate):ClockEstimate=>({...value,origin:BigInt(value.origin)});
const original=new ClockSync(initial.frequency,BigInt(initial.uptimeClock),initial.sentTime);
for(const row of all){assert.deepEqual(original.estimate,decode(row.before));assert.deepEqual(original.accept(row.sample,row.warmup),row.release?{...row.release,clock:BigInt(row.release.clock)}:null);assert.deepEqual(original.estimate,decode(row.after));assert.equal(original.revision,row.revision);}
assert.equal(all.length,14);assert(capture.recent.every(row=>row.release===null));
// The captured counter starts below 2^32 and never wraps. A production selector
// must preserve the uptime high word and raw modulo extension separately.
assert(BigInt(initial.uptimeClock)<0x100000000n);
for(let i=1;i<all.length;i++)assert(all[i].sample.clock32>all[i-1].sample.clock32);
const best=warm.reduce((a,b)=>b.sample.receiveTime-b.sample.sentTime<a.sample.receiveTime-a.sample.sentTime?b:a);
const variants=[{name:'first-known-warmup',row:warm[0]},{name:'minimum-rtt-warmup',row:best}].map(({name,row:anchor})=>{
 const index=warm.indexOf(anchor),sync=new ClockSync(initial.frequency,BigInt(anchor.sample.clock32),anchor.sample.sentTime);
 const rows=[...warm.slice(index+1),...capture.recent].map(row=>({revision:row.revision,warmup:row.warmup,release:sync.accept(row.sample,row.warmup)}));
 const regular=rows.filter(row=>!row.warmup);
 assert.equal(regular[0].release,null,'Delayed first periodic reply must still be filtered');
 const result={name,anchorRevision:anchor.revision,periodicAccepted:regular.filter(row=>row.release).length,periodicRejected:regular.filter(row=>!row.release).length};
 assert.deepEqual(result,evidence.expected.counterfactual.find(row=>row.name===name));
 return {...result,anchorRttMs:(anchor.sample.receiveTime-anchor.sample.sentTime)*1000,finalFrequencyHz:sync.estimate.frequency};
});
console.log(JSON.stringify({node:process.version,status:evidence.status,originalExactReplay:all.length,variants,scope:'Exact input and counterfactual initialization only. No live transport, timer, motion, production change or acceptance.'},null,2));
