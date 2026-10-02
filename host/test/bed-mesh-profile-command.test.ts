import test from 'node:test';
import assert from 'node:assert/strict';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {BedMeshProfileStore} from '../src/motion/bed-mesh-profile-store.ts';
import {registerBedMeshProfile,type BedMeshProfileRuntime} from '../src/motion/bed-mesh-profile-command.ts';
import {KlipperSaveSession} from '../src/config/klipper-save-session.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {parseKlipperMainText} from '../src/config/klipper-text.ts';
import {GCodeDispatch,GCodeError} from '../src/gcode/dispatch.ts';
const mesh=()=>new BedMesh({min_x:0,max_x:20,min_y:0,max_y:20,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.1,.2],[.3,.4]]);
function fixture(runtime:BedMeshProfileRuntime){const session=new KlipperSaveSession('/unused',''),store=new BedMeshProfileStore(new BedMeshProfiles(new ConfigurationReader(parseKlipperMainText('','/unused'),null)),session),output:string[]=[];const d=new GCodeDispatch({output:m=>output.push(m),shutdown:()=>{}});d.setReady(true);registerBedMeshProfile(d,store,runtime);return {d,store,session,output};}
test('profile commands preserve quoted names and LOAD precedence; saving and removing do not activate',async()=>{
 const activations:string[]=[],{d,store,session}=fixture({current:mesh,activate:(_m,n)=>{activations.push(n);}});await d.execute('BED_MESH_PROFILE SAVE="my mesh"');assert.deepEqual(store.names,['my mesh']);assert.equal(session.status.save_config_pending,true);await d.execute('BED_MESH_PROFILE LOAD="my mesh" SAVE=other REMOVE="my mesh"');assert.deepEqual(activations,['my mesh']);assert.deepEqual(store.names,['my mesh']);await d.execute('BED_MESH_PROFILE REMOVE="my mesh"');assert.deepEqual(store.names,[]);assert.deepEqual(activations,['my mesh']);
});
test('reserved default, missing probe and unknown removal do not publish profiles; blank and unknown loads reject',async()=>{
 const {d,store,output}=fixture({current:()=>null,activate:()=>{throw new Error('unexpected');}});await d.execute('BED_MESH_PROFILE SAVE=default\nBED_MESH_PROFILE SAVE=other\nBED_MESH_PROFILE REMOVE=absent\nBED_MESH_PROFILE');assert.deepEqual(store.names,[]);assert.match(output.join('\n'),/reserved/);assert.match(output.join('\n'),/not been probed/);assert.match(output.join('\n'),/No profile/);assert.match(output.join('\n'),/Invalid syntax/);await assert.rejects(d.execute('BED_MESH_PROFILE LOAD=" "'),/must be specified/);await assert.rejects(d.execute('BED_MESH_PROFILE LOAD=missing'),/Unknown bed mesh/);
});
test('activation failure preserves profile and blocks later movement with original cause',async()=>{
 const cause=new Error('switch failed'),{d,store}=fixture({current:mesh,activate:async()=>{throw cause;}});await d.execute('BED_MESH_PROFILE SAVE=p');await assert.rejects(d.execute('BED_MESH_PROFILE LOAD=p'),e=>e instanceof GCodeError&&e.cause===cause);assert.deepEqual(store.names,['p']);await assert.rejects(d.execute('G1 X1'),/activation failed/);
});
test('emergency cancels asynchronous activation and prevents success ACK and subsequent movement',async()=>{
 let enter!:()=>void;const entered=new Promise<void>(r=>{enter=r;});const {d,output}=fixture({current:mesh,activate:(_m,_n,signal)=>new Promise<void>((_r,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});enter();})});await d.execute('BED_MESH_PROFILE SAVE=p');output.length=0;const running=d.execute('BED_MESH_PROFILE LOAD=p\nG1 X1',{acknowledge:true}),result=Promise.allSettled([running]);await entered;d.emergencyStop('mesh emergency');assert.equal((await result)[0].status,'rejected');assert.equal(output.includes('ok'),false);await assert.rejects(d.execute('G1 X1'),/mesh emergency/);
});
