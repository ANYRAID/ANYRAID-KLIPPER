import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfiguration} from '../src/moonraker/config-source.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
const profile=`[bed_mesh default]\nversion: 1\nmin_x: 0\nmax_x: 20\nmin_y: 0\nmax_y: 20\nx_count: 2\ny_count: 2\nmesh_x_pps: 0\nmesh_y_pps: 0\nalgo: direct\ntension: 0.2\npoints:\n 0.125, 0.125\n 0.125, 0.125\n`;
async function config(text:string,run:(reader:ConfigurationReader)=>void){const dir=await mkdtemp(join(tmpdir(),'mesh-profiles-'));try{const path=join(dir,'printer.cfg');await writeFile(path,text);run(new ConfigurationReader(await loadConfiguration(path,{},null),null));assert.equal(await readFile(path,'utf8'),text);}finally{await rm(dir,{recursive:true,force:true});}}
test('stored config profile reaches motion compensation and each load owns its data',()=>config(profile,reader=>{const profiles=new BedMeshProfiles(reader),mesh=profiles.load('default');assert.deepEqual(profiles.names,['default']);assert.equal(mesh.average(),.12);mesh.setZeroReference(0,0);assert.equal(profiles.load('default').average(),.12);const port=new BedMeshMovePort({mesh:profiles.load('default'),fadeConfig:{end:10},physicalPosition:[0,0,.125,0],limits:motionLimits(300,3000),validate:()=>{}});port.move([10,0,10,0],50);assert.equal(port.plannedPosition[2],10.12);assert.throws(()=>profiles.load('missing'),/Unknown/);}));
test('incompatible versions are reported without reading fields or deleting config',()=>config(profile+'\n[bed_mesh old]\nversion: 0\n\n[bed_mesh future]\nversion: 9\n',reader=>{const p=new BedMeshProfiles(reader);assert.deepEqual(p.names,['default']);assert.deepEqual(p.incompatible,[{name:'old',version:0},{name:'future',version:9}]);const list=p.incompatible as {name:string;version:number}[];list[0].name='edited';assert.equal(p.incompatible[0].name,'old');}));
test('malformed matrix, algorithm and parameters fail during profile loading',async()=>{for(const text of [profile.replace('0.125, 0.125','0.125'),profile.replace('algo: direct','algo: nonsense'),profile.replace('x_count: 2','x_count: 129'),profile.replace('tension: 0.2','tension: NaN')])await config(text,reader=>assert.throws(()=>new BedMeshProfiles(reader)));});
