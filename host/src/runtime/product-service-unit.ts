import {access,readFile,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute,join,relative,sep} from 'node:path';

export interface ProductServiceUnitOptions {bundle:string;profile:string;user:string;}
function absolute(value:string):string {
 if(typeof value!=='string'||!isAbsolute(value)||/[\x00-\x1f\x7f]/u.test(value))throw new TypeError('Expected an absolute path without control characters');
 return value;
}
function inside(parent:string,child:string):boolean {const rel=relative(parent,child);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));}
// systemd syntax is not shell syntax. Percent specifiers apply to all paths;
// dollar expansion applies only to command arguments, including quoted ones.
function quote(value:string,command=false):string {return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',command?'$$':'$')+'"';}
/** Read-only deployment preparation. Never imports the machine module, opens
 * hardware, installs a unit, stops an existing service or enables startup. */
export async function productServiceUnit(options:ProductServiceUnitOptions):Promise<string> {
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(process.platform!=='linux'||major!==26||minor<9)throw new Error('Service generation requires Linux and Node.js 26.9 or later 26.x');
 if(!/^[a-z_][a-z0-9_-]{0,30}$/u.test(options.user)||options.user==='root')throw new TypeError('An explicit non-root service user is required');
 const bundle=absolute(await realpath(absolute(options.bundle))),profile=absolute(await realpath(absolute(options.profile))),node=absolute(await realpath(process.execPath));
 if(inside(bundle,profile)||inside(bundle,node))throw new Error('Machine profile and Node executable must be outside the replaceable bundle');
 if(!/\.(mjs|js)$/u.test(profile)||(await stat(profile)).isFile()===false)throw new Error('Compiled service requires a regular .mjs or ESM .js machine profile');
 const marker=JSON.parse(await readFile(join(bundle,'build-info.json'),'utf8'));
 if(marker?.schema!==1||marker.product!=='anyraid-product-host'||marker.platform!==process.platform||marker.arch!==process.arch||marker.modules!==process.versions.modules||!marker.files?.['scripts/product-host.js'])throw new Error('Product bundle identity or runtime ABI does not match');
 for(const [name,hash] of Object.entries(marker.files)){
  if(typeof hash!=='string'||!(/^[a-f0-9]{64}$/u.test(hash))||isAbsolute(name)||name.split(/[\\/]/u).some(part=>part==='..'||part===''||part==='.')||/[\x00-\x1f\x7f]/u.test(name))throw new Error('Invalid product inventory entry');
  const path=await realpath(join(bundle,name));if(!inside(bundle,path)||(await stat(path)).isFile()===false)throw new Error('Product inventory escapes bundle or is not a regular file');
  if(createHash('sha256').update(await readFile(path)).digest('hex')!==hash)throw new Error('Product bundle digest mismatch: '+name);
 }
 await access(node,constants.X_OK);
 const executable=join(bundle,'scripts/product-host.js');
 return `[Unit]\nDescription=ANYRAID Node product host\nAfter=network.target\nConflicts=klipper.service moonraker.service\n\n[Service]\nType=exec\nUser=${options.user}\nWorkingDirectory=/\nExecStart=${quote(node,true)} --no-experimental-strip-types ${quote(executable,true)} --profile ${quote(profile,true)}\nRestart=no\nKillSignal=SIGTERM\nKillMode=mixed\nTimeoutStopSec=90s\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export async function productServiceUnitCLI(args:readonly string[],write:(text:string)=>void):Promise<void>{
 if(args.length===1&&['--help','-h'].includes(args[0])){write('Usage: node scripts/product-service-unit.ts --bundle /absolute/product-host --profile /absolute/machine.mjs --user printer\nWrites a verified systemd unit to stdout. Does not install or start services.\n');return;}
 const parsed:Record<string,string>={};for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--bundle','--profile','--user'].includes(key)||key in parsed||!args[i+1])throw new Error('Expected exactly --bundle, --profile and --user');parsed[key]=args[i+1];}
 if(Object.keys(parsed).length!==3)throw new Error('Expected exactly --bundle, --profile and --user');
 write(await productServiceUnit({bundle:parsed['--bundle'],profile:parsed['--profile'],user:parsed['--user']}));
}
