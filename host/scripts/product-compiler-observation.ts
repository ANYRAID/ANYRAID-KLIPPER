import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import type {SpawnSyncReturns} from 'node:child_process';

type Fingerprint={bytes:number;sha256:string}|{unavailable:string};
export interface ProductCompilerInputs {
 schema:1;node:string;platform:string;arch:string;typescript:string|null;
 files:Record<string,Fingerprint>;
}
function errorCode(error:unknown):string {
 const code=(error as NodeJS.ErrnoException|null)?.code;
 return typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?code:'UNAVAILABLE';
}
/** Observe installed inputs before launch. This is neither an execution map nor
 * an attestation of source inputs, compiler libraries or concurrent writers. */
export async function captureProductCompilerInputs(host:string,config:string):Promise<ProductCompilerInputs>{
 const observe=async(path:string,metadata=false):Promise<{fingerprint:Fingerprint;text?:string}>=>{
  let file;
  try{
   file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);const info=await file.stat(),limit=metadata?64*1024:64*1024**2;
   if(!info.isFile()||info.size>limit)return {fingerprint:{unavailable:'NOT_BOUNDED_FILE'}};
   const hash=createHash('sha256'),chunks:Buffer[]=[];let bytes=0;
   for await(const chunk of file.createReadStream({autoClose:false,signal:AbortSignal.timeout(2000)})){
    bytes+=chunk.length;if(bytes>limit)return {fingerprint:{unavailable:'NOT_BOUNDED_FILE'}};hash.update(chunk);if(metadata)chunks.push(chunk);
   }
   return {fingerprint:{bytes,sha256:hash.digest('hex')},...(metadata?{text:Buffer.concat(chunks).toString('utf8')}:{})};
  }catch(error){return {fingerprint:{unavailable:errorCode(error)}};}
  finally{await file?.close().catch(()=>{});}
 };
 const packagePath=join(host,'node_modules/typescript/package.json'),packageInput=await observe(packagePath,true);
 const paths:Record<string,string>={entry:join(host,'node_modules/typescript/bin/tsc'),wrapper:join(host,'node_modules/typescript/lib/tsc.js'),resolver:join(host,'node_modules/typescript/lib/getExePath.js'),config,hostConfig:join(host,'tsconfig.json'),lock:join(host,'package-lock.json')};
 const files:Record<string,Fingerprint>={package:packageInput.fingerprint};let typescript:string|null=null;
 files.nativePackage=files.nativeCandidate={unavailable:'unavailable' in packageInput.fingerprint?packageInput.fingerprint.unavailable:'INVALID_PACKAGE_METADATA'};
 if(packageInput.text!==undefined)try{
  const pkg=JSON.parse(packageInput.text);
  if(typeof pkg?.version==='string'&&pkg.version.length<=64)typescript=pkg.version;
  // Walk installed dependency directories without invoking package resolution:
  // resolution can synchronously read a corrupt or FIFO package.json itself.
  // As before, the result is a candidate, not an execution-route attestation.
  const name='@typescript/typescript-'+process.platform+'-'+process.arch;
  let directory=join(dirname(await realpath(packagePath)),'lib');
  files.nativePackage=files.nativeCandidate={unavailable:'ENOENT'};
  for(let level=0;level<32;level++){
   if(basename(directory)!=='node_modules'){
    const packageFile=join(directory,'node_modules',name,'package.json'),input=await observe(packageFile,true);
    if(!('unavailable' in input.fingerprint)||!['ENOENT','ENOTDIR'].includes(input.fingerprint.unavailable)){
     files.nativePackage=input.fingerprint;
     if('unavailable' in input.fingerprint)files.nativeCandidate=input.fingerprint;
     else paths.nativeCandidate=join(dirname(packageFile),'lib',process.platform==='win32'?'tsc.exe':'tsc');
     break;
    }
   }
   const parent=dirname(directory);if(parent===directory)break;directory=parent;
  }
 }catch(error){files.nativeCandidate={unavailable:errorCode(error)};}
 for(const [name,value] of await Promise.all(Object.entries(paths).map(async([name,path])=>[name,(await observe(path)).fingerprint] as const)))files[name]=value;
 return {schema:1,node:process.version,platform:process.platform,arch:process.arch,typescript,files};
}
/** Keep the existing failure text and append only bounded, named metadata. */
export function productCompilerFailure(result:Pick<SpawnSyncReturns<string>,'error'|'status'|'signal'|'stdout'|'stderr'>,inputs:ProductCompilerInputs):Error {
 const observation={...inputs,status:result.status,signal:result.signal,errorCode:result.error?errorCode(result.error):null,scope:'Pre-launch file digests; nativeCandidate is the installed platform candidate. Actual wrapper launch route, loaded memory, source inputs and concurrent mutation are not attested.'};
 return new Error('Product TypeScript build failed: '+(result.error?.message??result.stdout+result.stderr)+'\nproductCompilerFailure='+JSON.stringify(observation));
}
