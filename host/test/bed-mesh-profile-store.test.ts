import test from 'node:test';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {BedMeshProfileStore} from '../src/motion/bed-mesh-profile-store.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {parseKlipperMainText} from '../src/config/klipper-text.ts';
const p={min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct' as const,tension:.2};
function fixture(text=''){const session=new KlipperSaveSession('/unused',''),profiles=new BedMeshProfiles(new ConfigurationReader(parseKlipperMainText(text,'/unused'),null));return {session,store:new BedMeshProfileStore(profiles,session)};}
test('session profile save owns exact probes, drops live offsets and returns independent loads/status',()=>{
 const {session,store}=fixture(),m=new BedMesh(p,[[.123456789,.4],[.5,.6]]);m.setOffsets(10,10);store.save('one',m);assert.equal(store.load('one').calcZ(0,0),.123456789);assert.equal(session.status.save_config_pending,true);const old=store.status;old.one.points[0][0]=99;store.load('one').setZeroReference(0,0);m.setZeroReference(0,0);assert.equal(store.load('one').calcZ(0,0),.123456789);assert.equal(store.remove('one'),true);assert.deepEqual(store.names,[]);assert.equal(store.remove('one'),false);assert.equal(session.status.save_config_pending_items['bed_mesh one'],null);
});
test('failed configuration publication leaves profiles and prior status unchanged',()=>{
 const {session,store}=fixture(),m=new BedMesh(p,[[1,2],[3,4]]);store.save('one',m);const old=store.status;assert.throws(()=>store.save('bad\nname',m));assert.deepEqual(store.status,old);session.apply=()=>{throw new Error('publication failed');};assert.throws(()=>store.save('two',m),/publication failed/);assert.throws(()=>store.remove('one'),/publication failed/);assert.deepEqual(store.status,old);
});
test('profile capacity and incompatible entries are preserved unless explicitly replaced',()=>{
 const {store}=fixture('[bed_mesh old]\nversion: 0\n'),m=new BedMesh(p,[[1,2],[3,4]]);assert.equal(store.remove('old'),false);assert.equal(store.incompatible.length,1);store.save('old',m);assert.deepEqual(store.incompatible,[]);for(let i=1;i<128;i++)store.save('p'+i,m);assert.throws(()=>store.save('overflow',m),/count/);store.save('old',m);assert.equal(store.names.length,128);
});
