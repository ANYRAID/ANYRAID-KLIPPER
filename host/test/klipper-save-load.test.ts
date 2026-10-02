import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {inspectKlipperConfiguration} from '../src/config/klipper-files.ts';
import {AUTOSAVE_HEADER} from '../src/config/klipper-autosave.ts';
async function fixture(run:(path:string,dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'save-load-'));try{await run(join(dir,'printer.cfg'),dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('loaded session keeps include settings regular and saves only filtered autosave values',async()=>fixture(async(path,dir)=>{
 await writeFile(join(dir,'child.cfg'),'[x]\na: included\n');const current='[include child.cfg]\n[printer]\nkinematics: cartesian\n'+AUTOSAVE_HEADER+'#*# [x]\n#*# a: stale\n#*# b: calibrated\n';await writeFile(path,current.replaceAll('\n','\r\n'));
 const loaded=await KlipperSaveSession.load(path);assert.equal(loaded.source.original.x.a,'included');assert.equal(loaded.source.original.x.b,'calibrated');assert.equal(loaded.session.status.save_config_pending,false);
 loaded.session.apply([{kind:'set',section:'x',option:'b',value:'updated'}]);const result=await loaded.session.save();assert.ok(result);assert.equal(await readFile(result.backupPath,'utf8'),current.replaceAll('\n','\r\n'));
 const next=await inspectKlipperConfiguration(path);assert.deepEqual({...next.autosave.x},{b:'updated'});assert.equal(next.source.original.x.a,'included');assert.equal(next.regular.original.printer.kinematics,'cartesian');assert.equal(await readFile(join(dir,'child.cfg'),'utf8'),'[x]\na: included\n');
}));
test('inspection preserves explicit DEFAULT inheritance without copying defaults into saved sections',async()=>fixture(async(path)=>{
 await writeFile(path,'[printer]\nkinematics: cartesian\n'+AUTOSAVE_HEADER+'#*# [DEFAULT]\n#*# offset: .1\n#*# [x]\n#*# value: 2\n');
 const loaded=await inspectKlipperConfiguration(path);assert.deepEqual({...loaded.autosave.x},{value:'2'});assert.deepEqual({...loaded.autosave.DEFAULT},{offset:'.1'});assert.equal(loaded.source.original.x.offset,'.1');assert.ok(Object.isFrozen(loaded.autosave.x));
 const {session}=await KlipperSaveSession.load(path);await session.save();const saved=await inspectKlipperConfiguration(path);assert.deepEqual(saved.autosave,loaded.autosave);
}));
test('load rejects corrupt autosave and pre-cancellation without creating a writable session',async()=>fixture(async(path)=>{
 await writeFile(path,'[x]\na: 1\n'+AUTOSAVE_HEADER+'modified content\n');await assert.rejects(KlipperSaveSession.load(path),/Corrupt/);await assert.rejects(KlipperSaveSession.load(path,{signal:AbortSignal.abort(new Error('cancel'))}),/cancel/);
}));
