import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {bedMeshProfileChanges} from '../src/motion/bed-mesh-save.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
const p={min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct' as const,tension:.2};
test('profile save keeps Python six-place rounding, signed zero and an owned frozen batch',()=>{
 const mesh=new BedMesh(p,[[.0078125,-.0078125],[-0,.123456789]]),changes=bedMeshProfileChanges('default',mesh);
 const point=changes.find(c=>c.kind==='set'&&c.option==='points');assert.ok(point?.kind==='set');assert.equal(point.value,'\n  0.007812, -0.007812\n  -0.000000, 0.123457');assert.ok(Object.isFrozen(changes));assert.ok(Object.isFrozen(changes[0]));mesh.setZeroReference(0,0);assert.match(point.value,/0.007812/);assert.throws(()=>bedMeshProfileChanges('bad\nname',mesh),/name/);
});
test('mesh calibration saves through a loaded session and reloads into motion with bounded quantization',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mesh-save-'));try{const path=join(dir,'printer.cfg');await writeFile(path,'[printer]\nkinematics: cartesian\n');const mesh=new BedMesh(p,[[.123456789,-.345678901],[.987654321,-.765432109]]),{session}=await KlipperSaveSession.load(path);session.apply(bedMeshProfileChanges('calibrated',mesh));await session.save();const loaded=await KlipperSaveSession.load(path),profiles=new BedMeshProfiles(new ConfigurationReader(loaded.source,null)),restored=profiles.load('calibrated');assert.deepEqual(restored.params,mesh.params);let max=0;for(let i=0;i<=100;i++){const x=i*.2,y=20-x;max=Math.max(max,Math.abs(restored.calcZ(x,y)-mesh.calcZ(x,y)));}assert.ok(max<=.0000005);assert.equal(loaded.session.status.save_config_pending,false);}finally{await rm(dir,{recursive:true,force:true});}
});
