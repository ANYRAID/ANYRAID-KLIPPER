// TLS paths follow pinned Moonraker application.py; GPL-3.0-or-later.
import {open,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createSecureContext} from 'node:tls';
import {ConfigurationError} from './config-source.ts';
import {resolveConfigurationPath} from './config-path.ts';
import type {ConfigurationReader} from './config-reader.ts';
import type {MoonrakerTlsOptions} from './server.ts';
async function exists(path:string):Promise<boolean>{try{return (await stat(path)).isFile();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function boundedPem(path:string,maximum:number):Promise<Buffer>{
 const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{const info=await file.stat();if(!info.isFile()||info.size<=0||info.size>maximum)throw new Error('Invalid TLS material');const buffer=Buffer.alloc(maximum+1);let size=0;while(size<buffer.length){const {bytesRead}=await file.read(buffer,size,buffer.length-size,size);if(!bytesRead)break;size+=bytesRead;}if(size>maximum||!size)throw new Error('Invalid TLS material');return buffer.subarray(0,size);}
 finally{await file.close();}
}
/** Startup-only material. The trusted process supplies dataPath; requests never
 * choose paths. No key, certificate or resolved filename enters error output. */
export async function readTlsConfiguration(reader:ConfigurationReader,dataPath?:string):Promise<MoonrakerTlsOptions|undefined>{
 const section=reader.section('server'),port=section.getInt('ssl_port',{defaultValue:7130,minval:0,maxval:65535}),certificate=section.get('ssl_certificate_path',{defaultValue:null,deprecate:true}),key=section.get('ssl_key_path',{defaultValue:null,deprecate:true});
 try{
  if(dataPath!==undefined&&(typeof dataPath!=='string'||!isAbsolute(dataPath)))throw new Error('Invalid TLS data directory');
  if(dataPath===undefined&&certificate===null&&key===null)return;
  const paths:string[]=[];
  for(const [raw,ext] of [[certificate,'cert'],[key,'key']] as const){const standard=dataPath===undefined?undefined:join(dataPath,'certs','moonraker.'+ext);if(standard!==undefined&&await exists(standard)){paths.push(standard);continue;}if(raw!==null){const path=resolveConfigurationPath(raw);if(!await exists(path))throw new Error('Configured TLS material is unavailable');paths.push(path);}else if(standard!==undefined)paths.push(standard);else paths.push('');}
  const available=await Promise.all(paths.map(path=>path?exists(path):false));
  if(!available.every(Boolean)){if(certificate!==null||key!==null)throw new Error('Configured TLS pair is incomplete');if(available.some(Boolean))reader.warn('TLS certificate and key are not both available; HTTPS is disabled');return;}
  const [cert,pemKey]=await Promise.all([boundedPem(paths[0],256*1024),boundedPem(paths[1],64*1024)]);
  const httpPort=section.getInt('port',{defaultValue:7125,minval:0,maxval:65535});if(port!==0&&port===httpPort)throw new Error('HTTP and HTTPS ports must differ');
  createSecureContext({cert,key:pemKey,minVersion:'TLSv1.2'});
  return Object.freeze({port,cert,key:pemKey});
 }catch{throw new ConfigurationError('Unable to load configured TLS certificate and key');}
}
