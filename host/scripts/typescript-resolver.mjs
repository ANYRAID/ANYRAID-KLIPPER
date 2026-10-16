// Resolve the locked official compiler in an isolated, cancellable process.
import {constants} from 'node:fs';
import {open,realpath,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {basename,dirname,isAbsolute,join} from 'node:path';
import {pathToFileURL} from 'node:url';

async function bounded(path,limit){
 const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();if(!info.isFile()||info.size>limit)throw new Error('Compiler metadata must be a bounded regular file');
  const chunks=[];let bytes=0;
  for await(const chunk of file.createReadStream({autoClose:false,signal:AbortSignal.timeout(2000)})){
   bytes+=chunk.length;if(bytes>limit)throw new Error('Compiler input exceeds capacity');chunks.push(chunk);
  }
  return {bytes:Buffer.concat(chunks),info};
 }finally{await file.close();}
}
async function json(path,limit=65536){return JSON.parse((await bounded(path,limit)).bytes.toString('utf8'));}
try{
 if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch))throw new Error('Owned TypeScript compilation requires Linux x64 or arm64');
 const host=process.argv[2];if(process.argv.length!==3||!isAbsolute(host))throw new Error('Expected an absolute compiler host directory');
 const name='@typescript/typescript-'+process.platform+'-'+process.arch;
 const lock=await json(join(host,'package-lock.json'),1024**2),pkg=await json(join(host,'node_modules/typescript/package.json'));
 const version=lock.packages?.['node_modules/typescript']?.version;
 if(typeof version!=='string'||!/^7\./u.test(version)||pkg.name!=='typescript'||pkg.version!==version||lock.packages?.['node_modules/'+name]?.version!==version)throw new Error('Installed TypeScript and platform lock versions do not match');
 const resolver=join(host,'node_modules/typescript/lib/getExePath.js');await bounded(resolver,65536);
 const getExePath=(await import(pathToFileURL(resolver).href)).default;
 if(typeof getExePath!=='function')throw new Error('Official compiler resolver is unavailable');
 const selected=getExePath();if(typeof selected!=='string'||!isAbsolute(selected)||basename(selected)!=='tsc')throw new Error('Invalid official compiler executable');
 if(!(await lstat(selected)).isFile())throw new Error('Compiler executable must be a regular file');
 const binary=await realpath(selected),native=await json(join(dirname(dirname(binary)),'package.json'));
 if(basename(dirname(binary))!=='lib'||native.name!==name||native.version!==version)throw new Error('Resolved compiler platform package does not match the lock');
 const {bytes,info}=await bounded(binary,64*1024**2);if(!bytes.length||(info.mode&0o111)===0)throw new Error('Compiler is not executable');
 process.stdout.write(JSON.stringify({schema:1,binary,typescript:version,nativePackage:name,nativeVersion:native.version,platform:process.platform,arch:process.arch,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,dev:info.dev,ino:info.ino,mode:info.mode,mtimeMs:info.mtimeMs})+'\n');
}catch(error){process.stderr.write((error instanceof Error?error.message:'Compiler resolution failed')+'\n');process.exitCode=1;}
