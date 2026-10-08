import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
const sha=b=>createHash('sha256').update(b).digest('hex'),hex=n=>'0x'+n.toString(16);
const archiveBytes=readFileSync('host/contracts/product-compiler-observation-acceptance.evidence.json.gz'),archive=JSON.parse(gunzipSync(archiveBytes)),accepted=JSON.parse(readFileSync('host/contracts/product-compiler-observation-acceptance.json'));
assert.equal(sha(archiveBytes),accepted.evidence.sha256);
for(const e of archive.entries)assert.equal(sha(e.text),e.sha256);
const full=archive.entries.find(e=>e.name==='full.log'),lines=full.text.split('\n');
const binary=readFileSync('host/node_modules/@typescript/typescript-linux-x64/lib/tsc'),binarySha=sha(binary);
assert.equal(binary.subarray(0,6).toString('hex'),'7f454c460201');assert.equal(binary.readUInt16LE(16),2);
const num=o=>Number(binary.readBigUInt64LE(o)),loads=[],sections=[],phoff=num(32),phsize=binary.readUInt16LE(54),shoff=num(40),shsize=binary.readUInt16LE(58);
for(let i=0;i<binary.readUInt16LE(56);i++){const o=phoff+i*phsize;if(binary.readUInt32LE(o)===1)loads.push({start:num(o+16),end:num(o+16)+num(o+40),flags:binary.readUInt32LE(o+4)});}
const names=num(shoff+binary.readUInt16LE(62)*shsize+24);
for(let i=0;i<binary.readUInt16LE(60);i++){const o=shoff+i*shsize,start=names+binary.readUInt32LE(o);sections.push({name:binary.subarray(start,binary.indexOf(0,start)).toString(),start:num(o+16),end:num(o+16)+num(o+32),flags:num(o+8)});}
const failures=[];let context=null,pending=null;
for(let i=0;i<lines.length;i++){
 if(lines[i].startsWith('test at '))context=lines[i];
 const fault=lines[i].match(/\[signal SIGSEGV:[^\n]*\baddr=(0x[0-9a-f]+) pc=(0x[0-9a-f]+)/);
 if(fault)pending={context,line:i+1,address:fault[1],pc:fault[2]};
 const marker=lines[i].indexOf('productCompilerFailure=');
 if(marker<0)continue;
 const observed=JSON.parse(lines[i].slice(marker+'productCompilerFailure='.length));assert(pending);assert.equal(observed.files.nativeCandidate.sha256,binarySha);
 const pc=Number(BigInt(pending.pc)),load=loads.find(s=>s.start<=pc&&pc<s.end),section=sections.find(s=>s.start<=pc&&pc<s.end);
 assert(load&&section);
 failures.push({...pending,observationLine:i+1,observation:observed,candidateElfMapping:{load:{start:hex(load.start),endExclusive:hex(load.end),executable:!!(load.flags&1)},section:{name:section.name,start:hex(section.start),endExclusive:hex(section.end),executable:!!(section.flags&4)}},scope:'Mapping of the file whose SHA-256 matches the pre-launch installed candidate; not proof of actual executable selection or loaded memory.'});pending=null;
}
assert.equal(failures.length,4);assert(failures.every(f=>f.observation.status===2&&f.observation.signal===null&&f.observation.errorCode===null));
const fatal=lines.findIndex(l=>l==='# Fatal error in , line 0');assert(fatal>=0);const nativeHistoryEvent=lines.findIndex((l,i)=>i>fatal&&l.startsWith('{"nodeTestFailure"'));assert(nativeHistoryEvent>fatal);
const event=JSON.parse(lines[nativeHistoryEvent]).nodeTestFailure;assert(event.file.endsWith('/native-history.test.ts'));assert.equal(event.error.signal,'SIGTRAP');
const excerpt=lines.slice(fatal,nativeHistoryEvent+1).join('\n');assert(excerpt.includes('# unreachable code'));assert(excerpt.includes('node::builtins::BuiltinLoader::LookupAndCompile'));assert(excerpt.includes('v8::ScriptCompiler::CompileFunction'));
const report={schema:1,date:'2026-10-08',sourceHead:'d10070931cbefebad4ed73ca1f6749efa1a46fc0',evidence:{archive:'product-compiler-observation-acceptance.evidence.json.gz',archiveSha256:sha(archiveBytes),entry:full.name,entrySha256:full.sha256},candidateSha256:binarySha,compilerFailures:failures,nodeFatal:{firstLine:fatal+1,lastLine:nativeHistoryEvent+1,excerpt,scope:'Original native stack and runner signal only; no Node executable digest at failure time or module evaluation boundary was captured.'},decision:'The four failed attempts now have matching pre-launch candidate file identity, so candidate-version differences before launch are not supported by these records. Actual wrapper route, loaded image/memory, concurrent mutation and common cause remain unproven; a further execution-mapping claim requires those missing observations, not another unchanged success run.',scope:'Read-only existing failure archive and matching current candidate ELF. No compiler/test execution, retry, source/product change, hardware attribution or G3 closure.',analyzerSha256:sha(readFileSync(new URL(import.meta.url)))};
writeFileSync(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({compilerFaults:failures.map(f=>({context:f.context,pc:f.pc,section:f.candidateElfMapping.section.name,status:f.observation.status})),nodeFatal:event.error.signal,candidateSha256:binarySha}));
