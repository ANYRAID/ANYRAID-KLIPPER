import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
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
 const fingerprint=async(path:string):Promise<Fingerprint>=>{
  let file;
  try{
   file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);const info=await file.stat();
   if(!info.isFile()||info.size>64*1024**2)return {unavailable:'NOT_BOUNDED_FILE'};
   const hash=createHash('sha256');let bytes=0;
   for await(const chunk of file.createReadStream({autoClose:false,signal:AbortSignal.timeout(2000)})){
    bytes+=chunk.length;if(bytes>64*1024**2)return {unavailable:'NOT_BOUNDED_FILE'};hash.update(chunk);
   }
   return {bytes,sha256:hash.digest('hex')};
  }catch(error){return {unavailable:errorCode(error)};}
  finally{await file?.close().catch(()=>{});}
 };
 const packagePath=join(host,'node_modules/typescript/package.json');
 const paths:Record<string,string>={entry:join(host,'node_modules/typescript/bin/tsc'),wrapper:join(host,'node_modules/typescript/lib/tsc.js'),resolver:join(host,'node_modules/typescript/lib/getExePath.js'),package:packagePath,config,hostConfig:join(host,'tsconfig.json'),lock:join(host,'package-lock.json')};
 let typescript:string|null=null,nativeError='UNAVAILABLE';
 try{
  const pkg=JSON.parse(await readFile(packagePath,'utf8'));
  if(typeof pkg.version==='string'&&pkg.version.length<=64)typescript=pkg.version;
  // The installed TypeScript 7 resolver selects this optional platform package.
  // Record it as a candidate: execve versus wrapper fallback is not observed.
  const nativePackage=createRequire(packagePath).resolve('@typescript/typescript-'+process.platform+'-'+process.arch+'/package.json');
  paths.nativePackage=nativePackage;paths.nativeCandidate=join(dirname(nativePackage),'lib',process.platform==='win32'?'tsc.exe':'tsc');
 }catch(error){nativeError=errorCode(error);}
 const files=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([name,path])=>[name,await fingerprint(path)])));
 if(!paths.nativeCandidate)files.nativeCandidate={unavailable:nativeError};
 return {schema:1,node:process.version,platform:process.platform,arch:process.arch,typescript,files};
}
/** Keep the existing failure text and append only bounded, named metadata. */
export function productCompilerFailure(result:Pick<SpawnSyncReturns<string>,'error'|'status'|'signal'|'stdout'|'stderr'>,inputs:ProductCompilerInputs):Error {
 const observation={...inputs,status:result.status,signal:result.signal,errorCode:result.error?errorCode(result.error):null,scope:'Pre-launch file digests; nativeCandidate is the installed platform candidate. Actual wrapper launch route, loaded memory, source inputs and concurrent mutation are not attested.'};
 return new Error('Product TypeScript build failed: '+(result.error?.message??result.stdout+result.stderr)+'\nproductCompilerFailure='+JSON.stringify(observation));
}
