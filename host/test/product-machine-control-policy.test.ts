import test from 'node:test';
import assert from 'node:assert/strict';
import {Script,createContext} from 'node:vm';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {productMachineControlPolicy,readProductMachineControl,productServiceUnitCLI} from '../src/runtime/product-service-unit.ts';
import {LinuxMachineControl} from '../src/moonraker/machine-control.ts';
const control={ownUnit:'anyraid-host.service',allowedUnits:['anyraid-host.service','crowsnest.service','klipper.service'],deviceUnits:['klipper.service']};
const principal={user:'printer',system_unit:control.ownUnit,no_new_privileges:true};
function policy(){let callback:((action:any,subject:any)=>unknown)|undefined;const context=createContext({polkit:{addRule:(rule:typeof callback)=>{assert.equal(callback,undefined);callback=rule;},Result:{YES:'yes',NO:'no'}}});new Script(productMachineControlPolicy('printer',control)).runInContext(context,{timeout:1000});assert(callback);return callback;}
test('generated policy grants only the declared unit/verb and basic power paths to the matching service principal',()=>{
 const decide=policy(),action=(id:string,unit?:unknown,verb?:unknown)=>({id,lookup:(key:string)=>key==='unit'?unit:key==='verb'?verb:undefined}),manage=(unit:unknown,verb:unknown)=>decide(action('org.freedesktop.systemd1.manage-units',unit,verb),principal);
 assert.equal(manage(control.ownUnit,'restart'),'yes');for(const unit of ['crowsnest.service','klipper.service'])for(const verb of ['start','stop','restart'])assert.equal(manage(unit,verb),'yes');for(const unit of ['reboot.target','poweroff.target'])assert.equal(manage(unit,'start'),'yes');
 for(const [unit,verb] of [[control.ownUnit,'stop'],[control.ownUnit,'start'],['crowsnest.service','reload'],['ssh.service','restart'],['run-transient.service','start'],['multi-user.target','start'],['reboot.target','stop'],[undefined,'start'],['crowsnest.service',undefined]])assert.equal(manage(unit,verb),'no');
 for(const id of ['org.freedesktop.login1.reboot','org.freedesktop.login1.power-off'])assert.equal(decide(action(id),principal),'yes');
 for(const id of ['org.freedesktop.login1.reboot-ignore-inhibit','org.freedesktop.login1.reboot-multiple-sessions','org.freedesktop.login1.power-off-ignore-inhibit','org.freedesktop.login1.power-off-multiple-sessions','org.freedesktop.login1.suspend','org.freedesktop.systemd1.manage-unit-files','org.freedesktop.systemd1.reload-daemon','org.freedesktop.systemd1.set-environment'])assert.equal(decide(action(id),principal),'no');
 assert.equal(decide(action('org.freedesktop.policykit.exec'),principal),undefined);
 const request=action('org.freedesktop.systemd1.manage-units','crowsnest.service','restart');for(const subject of [{...principal,system_unit:'user-1000.service'},{...principal,system_unit:undefined},{...principal,no_new_privileges:false},{...principal,no_new_privileges:undefined}])assert.equal(decide(request,subject),'no');assert.equal(decide(request,{...principal,user:'another'}),undefined);
});
test('descriptor validation matches runtime and rejects overbroad or injectable administrator inputs',()=>{
 for(const bad of [{...control,ownUnit:'bad.service\nNoNewPrivileges=no'},{...control,allowedUnits:['*.service']},{...control,deviceUnits:['ssh.service']},{...control,allowedUnits:Array.from({length:64},(_,i)=>'external-'+i+'.service')},{...control,force:true},{...control,allowedUnits:['crowsnest.service','crowsnest.service']}]){assert.throws(()=>productMachineControlPolicy('printer',bad));assert.throws(()=>new LinuxMachineControl(bad));}
 for(const user of ['root','printer\nroot','printer";grant()',''])assert.throws(()=>productMachineControlPolicy(user,control),/non-root/);
});
test('local descriptor reader bounds ordinary data and rejects symlinks, FIFO, malformed UTF-8 and unknown fields',async()=>{
 const root=await mkdtemp(join(tmpdir(),'machine-control-descriptor-')),path=join(root,'control.json');
 try{await writeFile(path,JSON.stringify(control));assert.deepEqual(await readProductMachineControl(path),control);const link=join(root,'link.json');await symlink(path,link);await assert.rejects(readProductMachineControl(link),/regular file/);const fifo=join(root,'fifo');execFileSync('mkfifo',[fifo],{timeout:5000});await assert.rejects(readProductMachineControl(fifo),/regular file/);await assert.rejects(readProductMachineControl('/dev/null'),/regular file/);
  for(const value of [Buffer.alloc(65537,32),Buffer.from([255]),Buffer.from(JSON.stringify({...control,force:true})),Buffer.from('null')]){await writeFile(path,value);await assert.rejects(readProductMachineControl(path));}
 }finally{await rm(root,{recursive:true,force:true});}
});
test('CLI verifies the bundle/profile and emits paired unit and policy without importing profiles or installing privileges',async()=>{
 const root=await mkdtemp(join(tmpdir(),'machine-control-preparation-')),bundle=join(root,'bundle'),profile=join(root,'machine.mjs'),descriptor=join(root,'control.json');
 try{await mkdir(join(bundle,'scripts'),{recursive:true});await writeFile(profile,'throw new Error("MUST NOT IMPORT");');await writeFile(descriptor,JSON.stringify(control));await writeFile(join(bundle,'scripts/product-host.js'),'process.exit(0);');await writeFile(join(bundle,'scripts/product-service-unit.js'),'process.exit(0);');const hash=createHash('sha256').update(await readFile(join(bundle,'scripts/product-host.js'))).digest('hex');await writeFile(join(bundle,'build-info.json'),JSON.stringify({schema:1,product:'anyraid-product-host',platform:process.platform,arch:process.arch,modules:process.versions.modules,files:{'scripts/product-host.js':hash}}));
  const args=['--bundle',bundle,'--profile',profile,'--user','printer','--machine-control',descriptor];let unit='';await productServiceUnitCLI(args,text=>{unit+=text;});assert.match(unit,/NoNewPrivileges=yes\n/);const path=join(root,control.ownUnit);await writeFile(path,unit);execFileSync('systemd-analyze',['verify',path],{timeout:5000,stdio:'pipe'});
  let generated='';await productServiceUnitCLI([...args,'--polkit'],text=>{generated+=text;});assert.equal(generated,productMachineControlPolicy('printer',control));
  for(const ownUnit of ['klipper.service','moonraker.service']){await writeFile(descriptor,JSON.stringify({...control,ownUnit}));let paired='';await productServiceUnitCLI(args,text=>{paired+=text;});const conflicts=paired.split('\n').find(line=>line.startsWith('Conflicts='))!;assert(!conflicts.slice('Conflicts='.length).split(' ').includes(ownUnit));const named=join(root,ownUnit);await writeFile(named,paired);execFileSync('systemd-analyze',['verify',named],{timeout:5000,stdio:'pipe'});}await writeFile(descriptor,JSON.stringify(control));
  for(const extra of [['--polkit','--polkit'],['--machine-control',descriptor],['--install','true']]){let output='';await assert.rejects(productServiceUnitCLI([...args,...extra],text=>{output+=text;}));assert.equal(output,'');}
  let output='';await assert.rejects(productServiceUnitCLI(args.filter((_,i)=>i<6).concat('--polkit'),text=>{output+=text;}),/requires --machine-control/);assert.equal(output,'');await writeFile(join(bundle,'scripts/product-host.js'),'tampered');await assert.rejects(productServiceUnitCLI([...args,'--polkit'],()=>assert.fail()),/digest mismatch/);
 }finally{await rm(root,{recursive:true,force:true});}
});
