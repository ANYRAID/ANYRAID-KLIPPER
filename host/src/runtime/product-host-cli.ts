import type {ProductHostControl} from './product-host-control.ts';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import type {ProductHostFactory} from './product-host.ts';
export const productHostHelp='Usage: node scripts/product-host.ts --profile /absolute/path/machine.ts\nCompiled: node scripts/product-host.js --profile /absolute/path/machine.mjs\nRuns a trusted machine integration module exporting createProductHostProfile(signal).\nSIGINT/SIGTERM stop admission and await hardware, operations and dependency cleanup.\nSIGHUP requests reinitialization only after the job is terminal and device actions have settled.\n';
export function parseProductHostArgs(args:readonly string[]):{profile:string}|undefined{
 if(args.length===1&&(args[0]==='--help'||args[0]==='-h'))return;
 if(args.length!==2||args[0]!=='--profile'||!isAbsolute(args[1])||/[\0\r\n]/u.test(args[1])||!/[.](?:ts|mts|js|mjs)$/u.test(args[1]))throw new Error('Expected --profile with an absolute .ts, .mts, .js or .mjs module path');
 return {profile:args[1]};
}
/** Parse help before loading native addons or machine code. Profile imports are
 * executable trusted configuration; only this explicit local path is imported. */
export async function runProductHostCLI(args:readonly string[],signal:AbortSignal,write:(text:string)=>void,control?:ProductHostControl):Promise<void>{
 const options=parseProductHostArgs(args);if(!options){write(productHostHelp);return;}
 const [major,minor]=process.versions.node.split('.').map(Number);if(major!==26||minor<9)throw new Error('Product host requires Node.js 26.9 or later in the 26.x series');
 signal.throwIfAborted();
 const module=await import(pathToFileURL(options.profile).href) as {createProductHostProfile?:ProductHostFactory};
 signal.throwIfAborted();if(typeof module.createProductHostProfile!=='function')throw new Error('Machine module must export createProductHostProfile');
 const {runProductHost}=await import('./product-host.ts');
 await runProductHost(module.createProductHostProfile,signal,address=>write(JSON.stringify({event:'ready',address})+'\n'),control);
}
