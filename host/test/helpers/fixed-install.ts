import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {DatabaseStore} from '../../src/moonraker/database.ts';
import {runFixedInstallHelper,fixedInstallUnit,type FixedInstallManifest} from '../../../scripts/product-install-helper.ts';
import type {SudoBackend,SudoOperation,SudoInstallReceipt} from '../../src/moonraker/sudo-backend.ts';
import {ApiError} from '../../src/moonraker/rpc.ts';
import type {FixedNodeInstallOptions} from '../../src/moonraker/fixed-node-install.ts';
export const installHash=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
const fixtureUnitPattern=/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}\.service$/u;
/** Test-only layout selection; never overrides the product's actual cgroup proof. */
export function fixedInstallFixtureUnit(cgroup:string):string{
 if(typeof cgroup!=='string'||!cgroup.isWellFormed()||Buffer.byteLength(cgroup)>65536||!cgroup.trim()||cgroup.includes('\0'))throw new TypeError('Invalid fixture cgroup');const units=new Set<string>();
 for(const line of cgroup.trimEnd().split('\n')){const match=/^\d+:[^:\r\n]*:(\/[^\r\n]*)$/u.exec(line);if(!match)throw new TypeError('Invalid fixture cgroup');let deepest:string|undefined;for(const component of match[1].split('/'))if(component.endsWith('.service')){if(!fixtureUnitPattern.test(component))throw new TypeError('Invalid fixture service unit');deepest=component;}if(deepest)units.add(deepest);}
 if(units.size>1)throw new TypeError('Conflicting fixture service units');return units.values().next().value??'anyraid.service';
}
export async function fixedInstallFixture(fixtureOptions:{unit?:string}={}){
 const unit=fixtureOptions.unit??'anyraid.service';if(typeof unit!=='string'||!fixtureUnitPattern.test(unit))throw new TypeError('Invalid fixture service unit');
 const root=await mkdtemp(join(tmpdir(),'fixed-node-install-')),dataPath=join(root,'data'),configRoot=join(dataPath,'config'),configFile=join(configRoot,'moonraker.conf'),databasePath=join(dataPath,'database/moonraker-sql.db'),logsRoot=join(dataPath,'logs'),gcodesRoot=join(dataPath,'gcodes'),bundle=join(root,'bundle'),profile=join(root,'profile.mjs'),manifestPath=join(root,'root-manifest.json'),unitPath=join(root,'etc/systemd/system',unit);
 await Promise.all([configRoot,dirnameDatabase(databasePath),logsRoot,gcodesRoot,join(dataPath,'systemd'),join(root,'etc/systemd/system'),join(root,'var/lib'),bundle].map(p=>mkdir(p,{recursive:true,mode:0o700})));
 const original=`[server]\n  host:127.0.0.1\n  port:0\n  route_prefix:printer\n  config_path:${configRoot}\n  log_path:${logsRoot}\n[database]\n  database_path:${dirnameDatabase(databasePath)}\n[secrets]\n  secrets_path:${join(dataPath,'moonraker.secrets')}\n`,oldUnit='[Service]\nUser=printer\nEnvironmentFile=/legacy/moonraker.env\n';
 const profileSource='throw Error("Never evaluate this profile in root helper");\n',bundleInfo='{"product":"isolated-fixture"}\n';
 await Promise.all([writeFile(configFile,original),writeFile(profile,profileSource),writeFile(join(bundle,'build-info.json'),bundleInfo),writeFile(join(dataPath,'moonraker.secrets'),'{}'),writeFile(unitPath,oldUnit),writeFile(join(dataPath,'systemd/moonraker.env'),'MOONRAKER_ARGS="-m moonraker"\n')]);
 const manifest:FixedInstallManifest={schema:1,unit,user:'printer',node:process.execPath,bundle,profile,dataPath,profileSha256:installHash(profileSource),bundleManifestSha256:installHash(bundleInfo),candidateSha256:'0'.repeat(64),previousUnitSha256:installHash(oldUnit)};manifest.candidateSha256=installHash(fixedInstallUnit(manifest));await writeFile(manifestPath,JSON.stringify(manifest));
 const options:FixedNodeInstallOptions={dataPath,configRoot,configFile,databasePath,logsRoot,gcodesRoot,unit,candidateSha256:manifest.candidateSha256,recoveryPath:join(dataPath,'systemd/node-install.json')};
 const commands:string[][]=[];let privateProbes=0,passwordlessStatus=0;let effect:((args:readonly string[],signal:AbortSignal)=>Promise<void>)|undefined;
 function backend():SudoBackend{let closed=false;return {async execute(operation:SudoOperation,password:Buffer|undefined,signal:AbortSignal){if(closed)throw new ApiError(503,'Fixture backend closed');signal.throwIfAborted();if(operation==='status'){
   // Simulates root-owned public proof; no sudo or password cache is consulted.
   passwordlessStatus++;const p=JSON.parse(await readFile(join(root,'var/lib/anyraid-install-attestations',unit+'.json'),'utf8'));if(p.candidateSha256!==manifest.candidateSha256||installHash(await readFile(unitPath))!==p.unitSha256)throw new ApiError(503,'Fixture proof differs');return {schema:1,phase:'installed',candidateSha256:p.candidateSha256,unitSha256:p.unitSha256,backup:null,envBackup:null};}
   privateProbes++;if(password?.toString()!=='fixture-password')throw new ApiError(400,'Fixture password invalid');return runFixedInstallHelper(manifestPath,operation,{root,async command(args){commands.push([...args]);await effect?.(args,signal);}},signal) as Promise<SudoInstallReceipt>;
  },async close(){closed=true;}};}
 const db=await DatabaseStore.open({path:databasePath});await db.insert('moonraker','validate_install.install_version',0);await db.close();
 return {root,dataPath,configRoot,configFile,databasePath,logsRoot,gcodesRoot,bundle,profile,manifestPath,manifest,options,unitPath,original,oldUnit,commands,backend,get counts(){return {privateProbes,passwordlessStatus};},setEffect(value:typeof effect){effect=value;},async close(){await rm(root,{recursive:true,force:true});}};
}
function dirnameDatabase(path:string){return path.slice(0,path.lastIndexOf('/'));}
