import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {productMachineFixture} from './helpers/product-machine.ts';
import {loadProductMachineProfile} from '../src/runtime/product-machine-profile.ts';
import {startConfiguredProductService} from '../src/runtime/product-service.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
test('mounted native configuration API persists an owned mesh and reloads through the product profile',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'config-product-')),f=await productMachineFixture(dir),signal=new AbortController().signal;
 let profile:Awaited<ReturnType<typeof loadProductMachineProfile>>|undefined,service:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined;
 try{
  await writeFile(f.config.printerConfig,(await readFile(f.config.printerConfig,'utf8'))+'\n[bed_mesh]\n');
  profile=await loadProductMachineProfile(f.path,async()=>f.bindings,signal);service=await startConfiguredProductService(profile.reader,profile.policies,profile.product,profile.options,signal);
  // Future probe owner supplies calibration; exercise the actual native transform.
  const mesh=new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.123456789012345,.2],[.3,.4]]);
  await service.printer.linear.port.replaceBedMesh(mesh,{},signal,'measured');
  const base=`http://127.0.0.1:${service.address.port}`,headers={'Content-Type':'application/json'},status=await (await fetch(base+'/printer/configuration')).json() as any;
  const saved=await fetch(base+'/printer/configuration/bed_mesh',{method:'POST',headers,body:JSON.stringify({version:1,state_token:status.result.state_token,profile:'retained'})});assert.equal(saved.status,200,await saved.clone().text());assert.equal((await saved.json() as any).result.state,'saved');assert(profile.product.maintenanceGate.status.closed);
  assert.equal(service.printer.linear.port.bedMeshStatus.profile_name,'measured');assert(f.transport.firmware.every(f=>f.motion.filter(m=>m.name==='queue_step').length===0));
  await service.close();service=undefined;await profile.release();profile=undefined;
  profile=await loadProductMachineProfile(f.path,async()=>f.bindings,signal);assert.deepEqual(new BedMeshProfiles(profile.reader).load('retained').probedValues(),mesh.probedValues());assert(!profile.product.maintenanceGate.status.closed);
 }finally{await service?.close();await profile?.release();await f.close();await rm(dir,{recursive:true,force:true});}
});
