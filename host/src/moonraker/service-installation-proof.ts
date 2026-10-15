import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {join,isAbsolute,resolve} from 'node:path';
import {userInfo} from 'node:os';
import {isDeepStrictEqual} from 'node:util';
import {MachineControlError} from './machine-control.ts';
import {currentPowerIdentity,type ProcessPowerIdentity} from './none-machine-control.ts';
import type {SystemdProperties} from './system-bus-owner.ts';
import type {ServiceInfoProof,ServiceInfoSource} from './service-info.ts';
import type {SudoDeploymentDeclaration} from './sudo-backend.ts';
export interface ServiceInstallationIdentity {
 read(signal:AbortSignal):Promise<SystemdProperties>;
 current(proof:SystemdProperties):boolean;
}
export interface InstallationTransition {schema:1;manifestSha256:string;sourceInfoSha256:string;installingProcess:ProcessPowerIdentity;}
export class InstallationServiceError extends MachineControlError {constructor(message:string){super('identity',message);}}
const fail=(message:string):never=>{throw new InstallationServiceError(message);};
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
export function validInstallationTransition(value:unknown):value is InstallationTransition{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as InstallationTransition,p=v.installingProcess;
 return Object.keys(value).length===4&&v.schema===1&&digest(v.manifestSha256)&&digest(v.sourceInfoSha256)&&!!p&&Object.keys(p).length===2&&Number.isSafeInteger(p.pid)&&p.pid>0&&typeof p.startTicks==='string'&&/^\d{1,32}$/u.test(p.startTicks);
}
async function commandLine(signal:AbortSignal):Promise<readonly string[]>{
 signal.throwIfAborted();const file=await open('/proc/self/cmdline',constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
 try{const bytes=Buffer.alloc(65537);let size=0;while(size<bytes.length){signal.throwIfAborted();const result=await file.read(bytes,size,bytes.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}signal.throwIfAborted();if(!size||size>65536||bytes[size-1]!==0)fail('Current Node arguments cannot be confirmed');const decoded=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size-1));return decoded.split('\0');}finally{await file.close();}
}
/** Source declarations describe the service file, not the actual executable.
 * Deployment bytes, current process facts and observed service facts are separate. */
export class ServiceInstallationProof {
 readonly #source:ServiceInstallationIdentity|undefined;readonly #info:ServiceInfoSource|undefined;readonly #deployment:((signal:AbortSignal)=>Promise<SudoDeploymentDeclaration|undefined>)|undefined;readonly #expected:{unit:string;candidateSha256:string;dataPath:string}|undefined;
 #proof:SystemdProperties|undefined;#infoProof:ServiceInfoProof|undefined;#manifest:SudoDeploymentDeclaration|undefined;#sourceFingerprint:string|undefined;
 constructor(source:ServiceInstallationIdentity|undefined,info?:ServiceInfoSource,deployment?:(signal:AbortSignal)=>Promise<SudoDeploymentDeclaration|undefined>,expected?:{unit:string;candidateSha256:string;dataPath:string}){
  if(source&&(!source||typeof source.read!=='function'||typeof source.current!=='function')||info&&(!info||typeof info.read!=='function'||typeof info.current!=='function')||source&&info||info&&typeof deployment!=='function')throw new TypeError('Invalid installation service identity');this.#source=source;this.#info=info;this.#deployment=deployment;this.#expected=expected;
 }
 get current(){return this.#info?this.#infoProof!==undefined&&this.#info.current(this.#infoProof):!this.#source||this.#proof!==undefined&&this.#source.current(this.#proof);}
 async refresh(signal:AbortSignal,expectedUnit?:string,phase:'source'|'target'='source',transition?:InstallationTransition){
  if(!this.#info){if(!this.#source)return;const proof=await this.#source.read(signal);signal.throwIfAborted();const value=proof.values;if(!Number.isSafeInteger(proof.generation)||proof.generation<0||!value||typeof value.Id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u.test(value.Id)||expectedUnit!==undefined&&value.Id!==expectedUnit||value.MainPID!==process.pid||value.LoadState!=='loaded'||typeof value.FragmentPath!=='string'||!value.FragmentPath.startsWith('/')||!this.#source.current(proof))throw new MachineControlError('identity','Installation service properties are unavailable or stale');this.#proof=proof;return;}
  this.#infoProof=undefined;const proof=await this.#info.read(signal);signal.throwIfAborted();const info=proof.info;
  if(info.manager!=='systemd')fail(info.manager==='none'?'No machine provider configured; automatic service installation is unavailable.':'Supervisor has no systemd FragmentPath; update the service manually or provide approved external deployment.');
  const declaration=await this.#deployment!(signal);signal.throwIfAborted();if(!declaration)fail('A manifest-bound Node deployment declaration is required for automatic service validation');
  const m=declaration!,properties=info.properties,fragment=properties.FragmentPath;
  if(!digest(m.manifestSha256)||!digest(m.candidateSha256)||!digest(m.previousUnitSha256)||!digest(m.profileSha256)||!digest(m.bundleManifestSha256)||m.schema!==1||!m.unit||info.unit_name!==m.unit||expectedUnit!==undefined&&m.unit!==expectedUnit||this.#expected&&(m.unit!==this.#expected.unit||m.candidateSha256!==this.#expected.candidateSha256||m.dataPath!==this.#expected.dataPath)||this.#manifest&&this.#manifest.manifestSha256!==m.manifestSha256)fail('Service facts differ from the approved Node deployment declaration');
  if([m.node,m.bundle,m.profile,m.dataPath].some(path=>typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||path==='/'||/[\0\r\n]/u.test(path))||typeof fragment!=='string'||!isAbsolute(fragment)||resolve(fragment)!==fragment||fragment!==join('/etc/systemd/system',m.unit)||typeof properties.User!=='string'||!properties.User||typeof properties.ExecStart!=='string'||!properties.ExecStart||typeof info.executable!=='string'||!isAbsolute(info.executable))fail('Service properties require manual installation; no approved fixed systemd source was found');
  const environment=properties.EnvironmentFiles,approvedEnvironment=join(m.dataPath,'systemd/moonraker.env');
  if(!Object.hasOwn(properties,'EnvironmentFiles'))fail('Service environment declaration is unavailable; update the service manually');
  if(info.environmentFiles){if(info.environmentFiles.length>1||info.environmentFiles.some(row=>row[0]!==approvedEnvironment))fail('Service environment declaration is outside the approved fixed installation layout');}
  else if(info.environmentDisplay===undefined||!['',approvedEnvironment,approvedEnvironment+' (ignore_errors=no)',approvedEnvironment+' (ignore_errors=yes)'].includes(info.environmentDisplay))fail('Service environment declaration is outside the approved fixed installation layout');
  if(phase==='source'){
   if(properties.User!==m.user||userInfo().username!==m.user)fail('Source service account differs from the approved current Node account; account migration requires explicit preparation');
   if(this.#sourceFingerprint!==undefined&&proof.fingerprint!==this.#sourceFingerprint)fail('Source service properties changed before installation');this.#sourceFingerprint??=proof.fingerprint;
  }else{
   if(transition!==undefined&&(!validInstallationTransition(transition)||transition.manifestSha256!==m.manifestSha256||transition.installingProcess.pid===proof.process.pid&&transition.installingProcess.startTicks===proof.process.startTicks))fail('Installation requires a different fresh Node process');
   const args=[m.node,'--no-experimental-strip-types',join(m.bundle,'scripts/product-host.js'),'--profile',m.profile],identity=await currentPowerIdentity(signal),actual=await commandLine(signal),executable=await realpath('/proc/self/exe');signal.throwIfAborted();
   // /proc argv is a process fact, not immutable authority: require the same
   // PID/startTicks, service owner, manifest and root candidate proof as well.
   if(identity.pid!==proof.process.pid||identity.startTicks!==proof.process.startTicks||executable!==m.node||!isDeepStrictEqual(actual,args)||properties.User!==m.user||userInfo().username!==m.user||properties.WorkingDirectory!=='/'||info.environmentFiles?.length||info.environmentDisplay!==undefined&&info.environmentDisplay!==''||info.executable!==m.node||(info.execArgv?!isDeepStrictEqual(info.execArgv,args):properties.ExecStart!==args.join(' ')))fail('Fresh process does not match the approved Node service target');
  }
  if(!this.#info.current(proof))fail('Service properties changed while confirming the installation declaration');this.#manifest=m;this.#infoProof=proof;
 }
 async transition(signal:AbortSignal,expectedUnit:string):Promise<InstallationTransition|undefined>{
  if(!this.#info)return undefined;await this.refresh(signal,expectedUnit,'source');const proof=this.#infoProof!,manifest=this.#manifest!;return Object.freeze({schema:1,manifestSha256:manifest.manifestSha256,sourceInfoSha256:proof.fingerprint,installingProcess:Object.freeze({...proof.process})});
 }
}
