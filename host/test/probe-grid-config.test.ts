import test from 'node:test';
import assert from 'node:assert/strict';
import {readProbeGrid} from '../src/config/probe-grid.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const read=(options:Record<string,string>)=>readProbeGrid(new ConfigurationReader(new ConfigurationSource('/grid.cfg',{bed_mesh:options},[]),null));
test('saved-only mesh remains valid; rectangular calibration defaults and pairs are typed',()=>{
 assert.equal(read({}),undefined);assert.deepEqual(read({mesh_min:'0,0',mesh_max:'10,10',zero_reference_position:'5,5'})?.zeroReference,[5,5]);const p=read({mesh_min:'10, 20',mesh_max:'100, 120',probe_count:'4,5',algorithm:'bicubic',mesh_pps:'0'})!;assert.equal(p.mesh.x_count,4);assert.equal(p.mesh.y_count,5);assert.equal(p.mesh.mesh_y_pps,0);assert.equal(p.horizontalHeight,5);
 for(const options of [{mesh_min:'0,0'},{mesh_radius:'50',round_probe_count:'4'},{mesh_min:'0,0',mesh_max:'10,10',probe_count:'2'},{mesh_min:'0,0',mesh_max:'10,10',zero_reference_position:'0'}] as Record<string,string>[])assert.throws(()=>read(options));
});

test('circular configuration rounds radius and spacing with translated origin',()=>{
 const grid=read({mesh_radius:'50.19',mesh_origin:'12,-7',round_probe_count:'7',algorithm:'bicubic'})!;
 assert.equal(grid.circle!.radius,50.1);assert.equal(grid.mesh.min_x,12-50.1);assert.equal(grid.mesh.max_y,-7+50.1);
 assert.equal(grid.mesh.x_count,7);assert.equal(read({mesh_radius:'50'})!.mesh.x_count,5);
 for(const options of [{mesh_radius:'.09'},{mesh_radius:'1',round_probe_count:'5'},{mesh_radius:'20',mesh_origin:'1'}] as Record<string,string>[])assert.throws(()=>read(options));
});
