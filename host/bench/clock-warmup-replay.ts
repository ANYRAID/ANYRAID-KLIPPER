import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {ClockSync,type ClockSample,type ClockEstimate,type ReleaseEstimate} from '../src/timing/clock-sync.ts';

type StoredEstimate=Omit<ClockEstimate,'origin'>&{origin:string};
type Row={sample:ClockSample;warmup:boolean;revision:number;before:StoredEstimate;after:StoredEstimate;release:(Omit<ReleaseEstimate,'clock'>&{clock:string})|null};
type Capture={id:string;initial:{frequency:number;uptimeClock:string;sentTime:number};count:number;warmup:Row[];recent:Row[]};
type Artifact={path:string;sha256:string};
type Evidence={log:Artifact;driverArtifacts:{actualInjectedDriver:Artifact;actualInputGenerator:Artifact};syntheticModel:Artifact&{compressedSha256:string;driver:Artifact};productionFingerprints:Record<string,string>;captures:Capture[]};
const root=new URL('../../',import.meta.url),evidence:Evidence=JSON.parse(await readFile(new URL('../contracts/clock-warmup-wire-counterexample.json',import.meta.url),'utf8'));
const digest=async(path:string)=>createHash('sha256').update(await readFile(new URL(path,root))).digest('hex');
assert.equal(await digest(evidence.log.path),evidence.log.sha256);
for(const artifact of [evidence.driverArtifacts.actualInjectedDriver,evidence.driverArtifacts.actualInputGenerator,evidence.syntheticModel.driver])assert.equal(await digest(artifact.path),artifact.sha256);
const model=await readFile(new URL(evidence.syntheticModel.path,root));assert.equal(createHash('sha256').update(model).digest('hex'),evidence.syntheticModel.compressedSha256);assert.equal(createHash('sha256').update(gunzipSync(model)).digest('hex'),evidence.syntheticModel.sha256);
for(const [path,sha] of Object.entries(evidence.productionFingerprints))assert.equal(await digest(path),sha,'Captured behavior belongs to unchanged source; a proposed fix needs a new comparison, not silently updated evidence.');
const estimate=(value:StoredEstimate):ClockEstimate=>({...value,origin:BigInt(value.origin)});
const results=evidence.captures.map(capture=>{
 const rows=[...capture.warmup,...capture.recent];assert.equal(rows.length,capture.count,'A truncated ring cannot claim complete replay.');
 const sync=new ClockSync(capture.initial.frequency,BigInt(capture.initial.uptimeClock),capture.initial.sentTime);
 for(const row of rows){
  assert.deepEqual(sync.estimate,estimate(row.before));
  assert.deepEqual(sync.accept(row.sample,row.warmup),row.release?{...row.release,clock:BigInt(row.release.clock)}:null);
  assert.deepEqual(sync.estimate,estimate(row.after));assert.equal(sync.revision,row.revision);
 }
 const regular=rows.filter(row=>!row.warmup),rejected=regular.filter(row=>row.release===null);
 return {id:capture.id,replayed:rows.length,unknownSendTimes:rows.filter(row=>row.sample.sentTime===0).length,rejectedRegular:rejected.length,firstRejectedRevision:rejected[0]?.revision,lastRejectedRevision:rejected.at(-1)?.revision,finalFrequency:sync.estimate.frequency};
});
assert.deepEqual(results.map(row=>[row.id,row.replayed,row.unknownSendTimes,row.rejectedRegular]),[['mcu',35,0,0],['aux',39,0,31]]);
console.log(JSON.stringify({node:process.version,results,scope:'Frozen controlled counterexample replay with unchanged source. Confirms retained estimator behavior; not a fix, remote root cause, runtime benchmark or hardware acceptance.'},null,2));
