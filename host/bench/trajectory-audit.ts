import {createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir,endianness} from 'node:os';
import {join} from 'node:path';

const fields=['printTime','duration','startVelocity','acceleration','x','y','z','xRatio','yRatio','zRatio'];
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const view=(values:Float64Array)=>Buffer.from(values.buffer,values.byteOffset,values.byteLength);
const copy=(values:Float64Array)=>Buffer.from(view(values));
const bits=(bytes:Buffer,index:number)=>index*8+8>bytes.length?null:`0x${(endianness()==='LE'?bytes.readBigUInt64LE(index*8):bytes.readBigUInt64BE(index*8)).toString(16).padStart(16,'0')}`;
export class TrajectoryMismatch extends Error {
 readonly directory:string;
 constructor(directory:string){super(`Exact trajectory mismatch; evidence saved in ${directory}`);this.directory=directory;}
}
/** Diagnostic only. Retains both the original extraction and detached byte
 * copies, so later corruption of a reference cannot silently redefine truth.
 * File writes and repeat extraction happen only on failure, outside timing. */
export class TrajectoryAudit {
 readonly #original:readonly Float64Array[];readonly #bytes:readonly Buffer[];readonly #hashes:readonly string[];
 constructor(expected:readonly Float64Array[]){this.#original=[...expected];this.#bytes=expected.map(copy);this.#hashes=this.#bytes.map(hash);}
 check(actual:readonly Float64Array[],repeat:()=>readonly Float64Array[],context:{iteration:number;mode:string;fixture?:()=>unknown},directory=tmpdir()):void{
  const baselineChanged=this.#original.some((a,i)=>!view(a).equals(this.#bytes[i]));
  const snapshotChanged=this.#bytes.some((b,i)=>hash(b)!==this.#hashes[i]);
  if(!baselineChanged&&!snapshotChanged&&actual.length===this.#bytes.length&&actual.every((a,i)=>view(a).equals(this.#bytes[i])))return;
  // Capture failing bytes before any additional native call or serialization.
  const captured=actual.map(copy),reference=this.#original.map(copy),path=mkdtempSync(join(directory,'anyraid-trajectory-mismatch-'));
  const records:(Record<string,unknown>)[]=[];
  for(const [kind,arrays] of [['expected',this.#bytes],['reference-now',reference],['actual',captured]] as const)for(const [i,b] of arrays.entries()){const file=`${kind}-${i}.bin`;writeFileSync(join(path,file),b);records.push({kind,queue:i,file,bytes:b.length,sha256:hash(b)});}
  let repeated:Buffer[]|undefined,repeatError:string|undefined;try{repeated=repeat().map(copy);}catch(error){repeatError=String(error);}
  for(const [i,b] of repeated?.entries()??[]){const file=`repeat-${i}.bin`;writeFileSync(join(path,file),b);records.push({kind:'repeat',queue:i,file,bytes:b.length,sha256:hash(b)});}
  const differences:Record<string,unknown>[]=[];
  for(let queue=0;queue<Math.max(this.#bytes.length,captured.length)&&differences.length<16;queue++){
   const expected=this.#bytes[queue]??Buffer.alloc(0),observed=captured[queue]??Buffer.alloc(0);
   for(let index=0;index<Math.max(expected.length,observed.length)/8&&differences.length<16;index++)if(bits(expected,index)!==bits(observed,index))differences.push({queue,index,row:Math.floor(index/10),field:fields[index%10],expectedBits:bits(expected,index),actualBits:bits(observed,index),repeatBits:repeated?.[queue]?bits(repeated[queue],index):null});
  }
  let fixtureError:string|undefined;try{if(context.fixture)writeFileSync(join(path,'fixture.json'),JSON.stringify(context.fixture()));}catch(error){fixtureError=String(error);}
  writeFileSync(join(path,'report.json'),JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,endianness:endianness(),iteration:context.iteration,mode:context.mode,baselineChanged,snapshotChanged,originalHashes:this.#hashes,repeatError,fixtureError,differences,records},null,2));
  throw new TrajectoryMismatch(path);
 }
}
