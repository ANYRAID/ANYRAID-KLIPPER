import {expandLogArgument,type ProcessLoggingOptions} from '../moonraker/process-logs.ts';
import type {ProductHostControl} from './product-host-control.ts';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {ProductHostFactory} from './product-host.ts';
export const productHostHelp='Usage: node scripts/product-host.ts --profile /absolute/path/machine.ts\nCompiled: node scripts/product-host.js --profile /absolute/path/machine.mjs\nRuns a trusted machine integration module exporting createProductHostProfile(signal).\n-l/--logfile selects an owned application file; -n/--nologfile disables it.\n-s/--structured-logging emits JSON lines; -v/--verbose emits stderr lifecycle records.\nMOONRAKER_LOG_PATH, MOONRAKER_DISABLE_FILE_LOG, MOONRAKER_STRUCTURED_LOGGING, MOONRAKER_VERBOSE_LOGGING supply defaults.\nSIGINT/SIGTERM stop admission and await hardware, operations and dependency cleanup.\nSIGHUP requests reinitialization only after the job is terminal and device actions have settled.\n';
export function parseProductHostArgs(args:readonly string[],env:NodeJS.ProcessEnv=process.env):{profile:string;logging?:ProcessLoggingOptions}|undefined{
 if(args.length===1&&(args[0]==='--help'||args[0]==='-h'))return;
 let profile:string|undefined;const yes=(key:string)=>['y','yes','true'].includes((env[key]??'').toLowerCase()),logging:ProcessLoggingOptions={};
 let logfile=env.MOONRAKER_LOG_PATH;
 if(yes('MOONRAKER_DISABLE_FILE_LOG'))logging.disableFile=true;if(yes('MOONRAKER_STRUCTURED_LOGGING'))logging.structured=true;if(yes('MOONRAKER_VERBOSE_LOGGING'))logging.verbose=true;
 const seen=new Set<string>();for(let i=0;i<args.length;i++){const argument=args[i],key=argument==='-l'?'--logfile':argument==='-n'?'--nologfile':argument==='-s'?'--structured-logging':argument==='-v'?'--verbose':argument;if(seen.has(key))throw new Error('Repeated product host option');seen.add(key);
 if(key==='--profile')profile=args[++i];else if(key==='--logfile'){const path=args[++i];if(!path)throw new Error('Missing logfile');logfile=path;}else if(key==='--nologfile')logging.disableFile=true;else if(key==='--structured-logging')logging.structured=true;else if(key==='--verbose')logging.verbose=true;else throw new Error('Unknown product host option');}
 if(!profile||!isAbsolute(profile)||/[\0\r\n]/u.test(profile)||!/[.](?:ts|mts|js|mjs)$/u.test(profile))throw new Error('Expected --profile with an absolute .ts, .mts, .js or .mjs module path');
 if(logfile&&!logging.disableFile)logging.applicationFile=expandLogArgument(logfile);
 return {profile,...Object.keys(logging).length?{logging}: {}};
}
/** Parse help before loading native addons or machine code. Profile imports are
 * executable trusted configuration; only this explicit local path is imported. */
export async function runProductHostCLI(args:readonly string[],signal:AbortSignal,write:(text:string)=>void,control?:ProductHostControl):Promise<void>{
 const options=parseProductHostArgs(args);if(!options){write(productHostHelp);return;}
 const [major,minor]=process.versions.node.split('.').map(Number);if(major!==26||minor<9)throw new Error('Product host requires Node.js 26.9 or later in the 26.x series');
 signal.throwIfAborted();
 const module=await import(pathToFileURL(options.profile).href) as {createProductHostProfile?:ProductHostFactory};
 signal.throwIfAborted();if(typeof module.createProductHostProfile!=='function')throw new Error('Machine module must export createProductHostProfile');
 if(options.logging){if(typeof module.createProductHostProfile.configureLogging!=='function')throw new Error('Machine factory does not support process logging');module.createProductHostProfile.configureLogging(options.logging);}
 const {runProductHost}=await import('./product-host.ts');
 await runProductHost(module.createProductHostProfile,signal,address=>write(JSON.stringify({event:'ready',address})+'\n'),control,address=>write(JSON.stringify({event:'listening',address})+'\n'));
}
