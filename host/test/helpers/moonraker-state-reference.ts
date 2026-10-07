import{readFileSync}from'node:fs';
import{gunzipSync}from'node:zlib';
import{createHash}from'node:crypto';
export const stateReferenceIdentity=Object.freeze({"path":"host/contracts/moonraker-state-python-reference.json.gz","compressedSha256":"a8dd07f8587f220878cf5c6306aefe33d4f182313f2a024be887c226057a1cd5","rawSha256":"409f79b9a2b95a27236d58f82e9ce975b245e3dab6d00b57effcc744681c0710","rawBytes":143351,"compressedBytes":4536,"sourceRefs":{"data-store":{"commit":"1cfb0c41e468645951a371621f06d32777b6107c","sourceSha256":"d32cc0f2a0673ae14f4075b76d0738be43d2ec7063b3849af7e2e75d1ce22dde"},"job-state":{"commit":"1cfb0c41e468645951a371621f06d32777b6107c","sourceSha256":"71c1647f8fabe4f4ee6678af1e55b75ce21f316b836ed1f3758340591214fe9e","enumSourceSha256":"dce362e0b0951b0e30250d7cd5cd4beeae36a7e29874d9d980710a4094a5e8b4"}},"python":"Python 3.12.13","scope":"Frozen independently executed original methods; historical timing is not a current Python or target-board comparison."});
const hash=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const ids=['gcode-test-0','job-test-0','job-test-1','gcode-bench-0','job-bench-0'] as const;
export type StateReferenceId=typeof ids[number];
type Capture={id:StateReferenceId;input:string;stdout:string;inputSha256:string;outputSha256:string;programSha256:string;results:number};
export function decodeStateReference(bytes:Uint8Array):{version:number;captures:Capture[]}{
 if(bytes.byteLength!==stateReferenceIdentity.compressedBytes||hash(bytes)!==stateReferenceIdentity.compressedSha256)throw Error('State reference compressed fingerprint mismatch');
 const raw=gunzipSync(bytes,{maxOutputLength:1024*1024});if(raw.byteLength!==stateReferenceIdentity.rawBytes||hash(raw)!==stateReferenceIdentity.rawSha256)throw Error('State reference raw fingerprint mismatch');
 const data=JSON.parse(raw.toString('utf8'));if(data.version!==1||!Array.isArray(data.captures)||data.captures.length!==5)throw Error('Invalid state reference shape');
 for(let i=0;i<5;i++){const c=data.captures[i];if(c.id!==ids[i]||typeof c.input!=='string'||typeof c.stdout!=='string'||hash(c.input)!==c.inputSha256||hash(c.stdout)!==c.outputSha256||c.results!==[4,108,3,11,11][i]||!Array.isArray(JSON.parse(c.stdout))||JSON.parse(c.stdout).length!==c.results)throw Error('Invalid state reference capture');}
 return data;
}
/** Fixed original input only. No cache retains other profiles or their outputs. */
export function stateReference<T>(id:StateReferenceId,input:string,count?:number,sampleCount?:number):T{
 if(id.endsWith('bench-0')&&(count!==100000||sampleCount!==11))throw Error('Uncaptured state benchmark workload');
 const data=decodeStateReference(readFileSync(new URL('../../contracts/moonraker-state-python-reference.json.gz',import.meta.url)));
 const c=data.captures.find(c=>c.id===id);if(!c||input!==c.input||hash(input)!==c.inputSha256)throw Error('Uncaptured state reference input');
 const result=JSON.parse(c.stdout);if(id.endsWith('bench-0')&&result.some((x:unknown)=>typeof x!=='number'||!Number.isFinite(x)||x<0))throw Error('Invalid historical timing');return result as T;
}
