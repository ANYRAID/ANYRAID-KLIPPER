import {lstat,readlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {isAbsolute,join,dirname} from 'node:path';
import {ConfigurationError} from './config-source.ts';
import type {ConfigurationReader} from './config-reader.ts';
const strip=(value:string)=>value.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
export interface KlippyPathContext {
 cwd?:string;home?:string;
 /** Full template ownership is external until the template component is ported. */
 render?:(source:string)=>string|Promise<string>;
}
/** Resolve components in order: normalizing '..' before following a symlink
 * would silently select a different socket than pathlib.Path.resolve(). */
export async function resolveKlippyPath(source:string,context:KlippyPathContext={}):Promise<string>{
 let value=strip(source);
 if(context.render)value=await context.render(value);
 else if(/[{}]/u.test(value))throw new ConfigurationError('Klippy path template renderer is required');
 if(typeof value!=='string'||!strip(value)||value.includes('\0')||Buffer.byteLength(value)>4096)throw new ConfigurationError('Invalid Klippy Unix socket path');
 value=strip(value);
 if(value==='~'||value.startsWith('~/')){const home=context.home??homedir();if(!isAbsolute(home))throw new ConfigurationError('Klippy home directory must be absolute');value=home+value.slice(1);}
 else if(value.startsWith('~'))throw new ConfigurationError('Named-user home expansion is not implemented');
 const cwd=context.cwd??process.cwd();if(!isAbsolute(cwd))throw new ConfigurationError('Klippy path working directory must be absolute');
 if(!isAbsolute(value))value=cwd+'/'+value;
 let current='/',links=0;const parts=value.split('/');
 while(parts.length){const part=parts.shift()!;if(!part||part==='.')continue;if(part==='..'){current=dirname(current);continue;}const next=join(current,part);
  try{const stat=await lstat(next);if(stat.isSymbolicLink()){if(++links>40)throw new ConfigurationError('Klippy path contains a symlink loop or too many links');const target=await readlink(next);if(isAbsolute(target))current='/';parts.unshift(...target.split('/'));continue;}}
  catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  current=next;
 }
 // Node/libuv must not silently truncate an overlong sockaddr_un pathname.
 if(Buffer.byteLength(current)>107)throw new ConfigurationError('Klippy Unix socket path exceeds Linux pathname capacity');
 return current;
}
export async function readKlippyBinding(reader:ConfigurationReader,context:KlippyPathContext={},retryDelayMs=250){
 if(!Number.isSafeInteger(retryDelayMs)||retryDelayMs<1||retryDelayMs>60000)throw new ConfigurationError('Invalid Klippy retry delay');
 const section=reader.section('server'),source=section.get('klippy_uds_address',{defaultValue:'/tmp/klippy_uds'});
 // Upstream getpath returns its Path default without rendering or resolving it.
 return Object.freeze({path:section.hasOption('klippy_uds_address')?await resolveKlippyPath(source,context):source,retryDelayMs});
}
