// Bounded, read-only replay of the archived same-invocation weighted4 capture.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {deserialize} from 'node:v8';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {inspectWeighted4Window} from './diagnostics/weighted-filter-oracle.ts';
if(process.argv.length!==2)throw new Error('No arguments expected; this tool binds the archived weighted4 invocation');
const capture=fileURLToPath(new URL('../../docs/diagnostics/node26-motion-capture-20260928/motion-mismatch-351330-12.bin.gz',import.meta.url));
const compressed=readFileSync(capture);if(compressed.length>32*1024*1024)throw new Error('Capture exceeds bounded input');
const raw=gunzipSync(compressed,{maxOutputLength:64*1024*1024}),hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
if(hash(raw)!=='4fd344604a2dfa98bc2c4cfad80515c0df10ea4658565827e3e0619264908fb6')throw new Error('Archived invocation fingerprint changed');
const c=deserialize(raw);if(c.version!==3||c.run!==12||c.index!==4897||!Array.isArray(c.stages?.nominal)||!Array.isArray(c.stages?.updated))throw new Error('Archived invocation shape changed');
const started=performance.now(),observations=[4896,4897,4898].map(i=>inspectWeighted4Window(c.stages.nominal,c.stages.updated[i],i));
console.log(JSON.stringify({node:process.version,nodeSha256:hash(readFileSync(process.execPath)),capture:{compressedSha256:hash(compressed),rawSha256:hash(raw)},method:'BigInt exact dyadic arithmetic and independent quotient/remainder ties-to-even rounding; captured inputs only',observations:observations.map(({taps,...summary})=>({...summary,tapLedgerSha256:hash(Buffer.from(JSON.stringify(taps)))})),elapsedMs:performance.now()-started,scope:'The ledger reconstructs saved operands; it does not recover transient tap values in the failed process. Does not establish runtime/hardware cause, production isolation, G3 closure or printing speed.'},null,2));
