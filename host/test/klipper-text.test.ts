import test from 'node:test';
import assert from 'node:assert/strict';
import {KlipperConfigText,parseKlipperMainText} from '../src/config/klipper-text.ts';
import {AUTOSAVE_HEADER} from '../src/config/klipper-autosave.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {BedMeshProfiles} from '../src/motion/bed-mesh-profiles.ts';
test('Klipper text preserves duplicate override, defaults, multiline values and comment semantics',()=>{const p=new KlipperConfigText();p.append('[DEFAULT]\nSpeed: 10\n[x]\na: old\na: new#cut\ntext: first\n  second;kept\n\n  third ;cut\n[x]\nSpeed: 20\n');assert.deepEqual({...p.values().x},{speed:'20',a:'new',text:'first\nsecond;kept\n\nthird'});assert.throws(()=>p.append('[x]\na: changed\nbroken'));assert.equal(p.values().x.a,'new');});
test('main text merges saved profile while explicit ordinary values win',()=>{const saved='[bed_mesh default]\nversion: 1\nmin_x: 0\nmax_x: 20\nmin_y: 0\nmax_y: 20\nx_count: 2\ny_count: 2\nmesh_x_pps: 0\nmesh_y_pps: 0\nalgo: direct\ntension: .2\npoints:\n  .1,.1\n  .1,.1';const text='[bed_mesh default]\npoints:\n  .2,.2\n  .2,.2\n'+AUTOSAVE_HEADER+saved.split('\n').map(l=>'#*# '+l).join('\n');const source=parseKlipperMainText(text.replaceAll('\n','\r\n'),'printer.cfg'),profiles=new BedMeshProfiles(new ConfigurationReader(source,null));assert.equal(profiles.load('default').average(),.2);assert.equal(source.original['bed_mesh default'].version,'1');});
test('includes and corrupted saved values cannot disappear silently',()=>{assert.throws(()=>parseKlipperMainText('[include machine.cfg]\n','printer.cfg'),/include expansion/);assert.throws(()=>parseKlipperMainText(AUTOSAVE_HEADER+'edited=true','printer.cfg'),/Corrupt/);});
