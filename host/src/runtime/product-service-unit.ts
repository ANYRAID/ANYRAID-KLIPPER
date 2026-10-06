import {access,open,readFile,realpath,stat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {isAbsolute,join,relative,sep} from 'node:path';
import {validateMachineControlOptions,type MachineControlOptions} from '../moonraker/machine-control.ts';

export interface ProductServiceUnitOptions {bundle:string;profile:string;user:string;machineControl?:MachineControlOptions;}
function serviceUser(user:string):void{if(typeof user!=='string'||!/^[a-z_][a-z0-9_-]{0,30}$/u.test(user)||user==='root')throw new TypeError('An explicit non-root service user is required');}
function absolute(value:string):string {
 if(typeof value!=='string'||!isAbsolute(value)||/[\x00-\x1f\x7f]/u.test(value))throw new TypeError('Expected an absolute path without control characters');
 return value;
}
function inside(parent:string,child:string):boolean {const rel=relative(parent,child);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));}
// systemd syntax is not shell syntax. Percent specifiers apply to all paths;
// dollar expansion applies only to command arguments, including quoted ones.
function quote(value:string,command=false):string {return '"'+value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',command?'$$':'$')+'"';}
/** Local administrator data, never read from an HTTP request or imported as code.
 * Linux O_PATH pins an inode without opening a device/FIFO for I/O. Check its
 * type before reopening the pinned regular inode through procfs, so replacing
 * the original pathname cannot redirect the read to hardware. */
export async function readProductMachineControl(path:string):Promise<MachineControlOptions>{
 if(process.platform!=='linux')throw new Error('Machine control preparation requires Linux with procfs');
 // Linux asm-generic/fcntl.h O_PATH (010000000), absent from Node fs.constants.
 const pinned=await open(absolute(path),0x200000|constants.O_NOFOLLOW);
 try{
  const info=await pinned.stat();if(!info.isFile()||info.size>65536)throw new Error('Machine control descriptor must be a regular file of at most 65536 bytes');
  const file=await open('/proc/self/fd/'+pinned.fd,constants.O_RDONLY|constants.O_NONBLOCK);
  try{const current=await file.stat();if(!current.isFile()||current.dev!==info.dev||current.ino!==info.ino||current.size>65536)throw new Error('Machine control descriptor inode changed');const bytes=Buffer.alloc(65537);let size=0;while(size<bytes.length){const read=await file.read(bytes,size,bytes.length-size,null);if(!read.bytesRead)break;size+=read.bytesRead;}if(size>65536)throw new Error('Machine control descriptor exceeds 65536 bytes');const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)));validateMachineControlOptions(value);return {ownUnit:value.ownUnit,...value.allowedUnits?{allowedUnits:[...value.allowedUnits]}:{},...value.deviceUnits?{deviceUnits:[...value.deviceUnits]}:{}};}finally{await file.close();}
 }finally{await pinned.close();}
}
/** Read-only site policy preparation for the dedicated printer appliance.
 * The administrator reviews/installs it separately. No group-wide grant, KEEP,
 * helper spawn, unit-file management, transient units or login1 force actions.
 * Exact power targets support systemctl's normal PID1 fallback; this is not
 * an independent inhibitor policy or a boundary against a compromised owner.
 * Unsupported Subject attributes fail closed, never fall back to user alone. */
export function productMachineControlPolicy(user:string,control:MachineControlOptions):string{
 serviceUser(user);validateMachineControlOptions(control);
 const own=JSON.stringify(control.ownUnit),external=JSON.stringify((control.allowedUnits??[]).filter(unit=>unit!==control.ownUnit).toSorted());
 return '// Site-specific administrator policy; generated read-only, never auto-installed.\n'+
  'polkit.addRule(function(action, subject) {\n'+
  `  if (subject.user !== ${JSON.stringify(user)}) return;\n`+
  '  if (action.id.indexOf("org.freedesktop.systemd1.") !== 0 && action.id.indexOf("org.freedesktop.login1.") !== 0) return;\n'+
  `  if (subject.system_unit !== ${own} || subject.no_new_privileges !== true) return polkit.Result.NO;\n`+
  '  if (action.id === "org.freedesktop.systemd1.manage-units") {\n'+
  '    var unit = action.lookup("unit"), verb = action.lookup("verb");\n'+
  `    if (unit === ${own} && verb === "restart") return polkit.Result.YES;\n`+
  `    if (${external}.indexOf(unit) !== -1 && ["start", "stop", "restart"].indexOf(verb) !== -1) return polkit.Result.YES;\n`+
  '    if (["reboot.target", "poweroff.target"].indexOf(unit) !== -1 && verb === "start") return polkit.Result.YES;\n'+
  '    return polkit.Result.NO;\n  }\n'+
  '  if (action.id === "org.freedesktop.login1.reboot" || action.id === "org.freedesktop.login1.power-off") return polkit.Result.YES;\n'+
  '  if (action.id.indexOf("org.freedesktop.login1.") === 0 || action.id.indexOf("org.freedesktop.systemd1.") === 0) return polkit.Result.NO;\n'+
  '});\n';
}
/** Read-only deployment preparation. Never imports the machine module, opens
 * hardware, installs a unit, stops an existing service or enables startup. */
export async function verifyProductBundle(input:string):Promise<string>{
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major!==26||minor<9)throw new Error('Product bundle requires Node.js 26.9 or later 26.x');
 const bundle=absolute(await realpath(absolute(input)));
 const marker=JSON.parse(await readFile(join(bundle,'build-info.json'),'utf8'));
 if(marker?.schema!==1||marker.product!=='anyraid-product-host'||marker.platform!==process.platform||marker.arch!==process.arch||marker.modules!==process.versions.modules||!marker.files?.['scripts/product-host.js'])throw new Error('Product bundle identity or runtime ABI does not match');
 for(const [name,hash] of Object.entries(marker.files)){
  if(typeof hash!=='string'||!(/^[a-f0-9]{64}$/u.test(hash))||isAbsolute(name)||name.split(/[\\/]/u).some(part=>part==='..'||part===''||part==='.')||/[\x00-\x1f\x7f]/u.test(name))throw new Error('Invalid product inventory entry');
  const path=await realpath(join(bundle,name));if(!inside(bundle,path)||(await stat(path)).isFile()===false)throw new Error('Product inventory escapes bundle or is not a regular file');
  if(createHash('sha256').update(await readFile(path)).digest('hex')!==hash)throw new Error('Product bundle digest mismatch: '+name);
 }
 return bundle;
}
export async function productServiceUnit(options:ProductServiceUnitOptions):Promise<string> {
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(process.platform!=='linux'||major!==26||minor<9)throw new Error('Service generation requires Linux and Node.js 26.9 or later 26.x');
 const user=options.user,control=options.machineControl;serviceUser(user);if(control!==undefined)validateMachineControlOptions(control);
 const conflicts=['klipper.service','moonraker.service'].filter(unit=>unit!==control?.ownUnit).join(' ');
 const bundle=absolute(await realpath(absolute(options.bundle))),profile=absolute(await realpath(absolute(options.profile))),node=absolute(await realpath(process.execPath));
 if(inside(bundle,profile)||inside(bundle,node))throw new Error('Machine profile and Node executable must be outside the replaceable bundle');
 if(!/\.(mjs|js)$/u.test(profile)||(await stat(profile)).isFile()===false)throw new Error('Compiled service requires a regular .mjs or ESM .js machine profile');
 await verifyProductBundle(bundle);
 await access(node,constants.X_OK);
 const executable=join(bundle,'scripts/product-host.js');
 return `[Unit]\nDescription=ANYRAID Node product host\nAfter=network.target\nConflicts=${conflicts}\n\n[Service]\nType=exec\nUser=${user}\n${control?'NoNewPrivileges=yes\n':''}WorkingDirectory=/\nExecStartPre=${quote(node,true)} --no-experimental-strip-types ${quote(join(bundle,'scripts/product-service-unit.js'),true)} --verify-bundle ${quote(bundle,true)}\nExecStart=${quote(node,true)} --no-experimental-strip-types ${quote(executable,true)} --profile ${quote(profile,true)}\nRestart=no\nKillSignal=SIGTERM\nKillMode=mixed\nTimeoutStopSec=90s\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=multi-user.target\n`;
}
export async function productServiceUnitCLI(args:readonly string[],write:(text:string)=>void):Promise<void>{
 if(args.length===1&&['--help','-h'].includes(args[0])){write('Usage: node scripts/product-service-unit.ts --bundle /absolute/product-host --profile /absolute/machine.mjs --user printer [--machine-control /absolute/control.json] [--polkit]\nUse --verify-bundle /absolute/product-host for a read-only startup check.\n--machine-control enables NoNewPrivileges in the generated unit; --polkit instead prints its site-specific policy and requires that descriptor.\nSave the unit under the descriptor ownUnit name; configure the trusted profile from the same descriptor.\nWrites verified preparation to stdout. Does not install or start services.\n');return;}
 if(args.length===2&&args[0]==='--verify-bundle'){await verifyProductBundle(args[1]);write('Product bundle verified\n');return;}
 const parsed:Record<string,string>={};let policy=false;for(let i=0;i<args.length;){const key=args[i++];if(key==='--polkit'){if(policy)throw new Error('Duplicate --polkit');policy=true;continue;}if(!['--bundle','--profile','--user','--machine-control'].includes(key)||key in parsed||!args[i])throw new Error('Expected exactly --bundle, --profile and --user, with optional --machine-control and --polkit');parsed[key]=args[i++];}
 if(!parsed['--bundle']||!parsed['--profile']||!parsed['--user']||policy&&!parsed['--machine-control'])throw new Error('Expected exactly --bundle, --profile and --user; --polkit requires --machine-control');
 const machineControl=parsed['--machine-control']?await readProductMachineControl(parsed['--machine-control']):undefined;
 const unit=await productServiceUnit({bundle:parsed['--bundle'],profile:parsed['--profile'],user:parsed['--user'],machineControl});
 write(policy?productMachineControlPolicy(parsed['--user'],machineControl!):unit);
}
