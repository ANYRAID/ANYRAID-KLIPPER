import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parsePrusaMetadata,type PrusaFamily} from '../src/moonraker/metadata-prusa.ts';
import {metadataInteger,metadataSum,roundMetadataHeight,findStrings,pythonJsonStrings} from '../src/moonraker/metadata-values.ts';
const parse=(footer:string,family:PrusaFamily='PrusaSlicer',header='')=>parsePrusaMetadata({footer,header,size:Buffer.byteLength(footer+header)},family);
test('Prusa configuration and Bambu overrides read the original header/footer locations',()=>{
 const footer='; layer_height = .2\n; first_layer_height = 150%\n; total layers count = 100\n; first_layer_temperature = 210\n; printer_vendor = "ANYRAID"\n',header='; layer_height = .1\n; initial_layer_print_height = .25\n; total layer number: 80\n; nozzle_temperature_initial_layer = 220\n; printer_vendor = "Wrong"\n';
 const prusa=parse(footer,'PrusaSlicer',header),bambu=parse(footer,'BambuStudio',header);
 assert.equal(prusa.first_layer_height,.3);assert.equal(prusa.layer_count,100);assert.equal(prusa.first_layer_extr_temp,210);
 assert.equal(bambu.first_layer_height,.25);assert.equal(bambu.layer_height,.1);assert.equal(bambu.layer_count,80);assert.equal(bambu.first_layer_extr_temp,220);assert.equal(bambu.printer_vendor,'ANYRAID');
 assert.equal(parse('; first_layer_height = 150%\n').first_layer_height,undefined);
 assert.deepEqual(parse(''),{filament_colors:[],extruder_colors:[],filament_temps:[],referenced_tools:[]});
});
test('multi-material strings preserve quotes, separators, Unicode JSON and integer syntax',()=>{
 const fields=parse('; filament_type = "PLA, Silk";"中😀"\n; filament_settings_id = "A\\"B";C\n; temperature = ２００;+210;2_20\n; referenced_tools = -0;٢\n');
 assert.equal(fields.filament_type,'["PLA, Silk", "\\u4e2d\\ud83d\\ude00"]');assert.equal(fields.filament_name,'["A\\"B", "C"]');assert.deepEqual(fields.filament_temps,[200,210,220]);assert.deepEqual(fields.referenced_tools,[0,2]);
 assert.equal(parse('; temperature = 200;bad\n').filament_temps,undefined);
 assert.deepEqual(findStrings('; x = (%S)','; x = ""; ;" a;b "; c'),['a;b','c']);
 assert.equal(pythonJsonStrings(['\u007f','\ufeff']), '["\\u007f", "\\ufeff"]');
 assert.equal(metadataInteger('1__2'),undefined);assert.equal(metadataInteger('²'),undefined);assert.throws(()=>metadataInteger('9007199254740993'),/Unsafe/);
});
test('height rounding uses the binary input and ties to even; float sums preserve tiny terms',()=>{
 assert.equal(roundMetadataHeight(0.0000005),0);assert.equal(roundMetadataHeight(0.0000015),0.000002);assert.equal(roundMetadataHeight(0.0000025),0.000003);
 assert.ok(Object.is(roundMetadataHeight(-0.0000005),-0));assert.equal(roundMetadataHeight(1e100),1e100);
 assert.equal(metadataSum([1e16,1,1]),10000000000000002);assert.equal(metadataSum([1e16,1,-1e16]),1);
 const fields=parse('; filament used [mm] = 10000000000000000,1,1\n; layer_height = .333333\n; first_layer_height = 123.45%\n');
 assert.equal(fields.filament_total,10000000000000002);assert.equal(fields.first_layer_height,0.4115);
});
test('derived Slic3r fields preserve units, absent overrides and toolchange precedence',()=>{
 const text='; filament used [mm] = 100\n; filament used = 12.5mm\n; filament_length_m = 1.25\n; filament mass_g = 4.5\n; estimated printing time = 1h 2m 3s\n; total toolchanges = 0\n; total filament change = 5\n;BEFORE_LAYER_CHANGE\n;١٢.٥\nG1 Z100 F1200\n';
 assert.equal(parse(text,'Slic3rPE').filament_total,12.5);assert.equal(parse(text,'Slic3r').filament_total,1250);assert.equal(parse(text,'Slic3r').filament_weight_total,4.5);assert.equal(parse(text,'Slic3r').estimated_time,undefined);
 assert.equal(parse(text).estimated_time,3723);assert.equal(parse(text).filament_change_count,0);assert.equal(parse(text).object_height,12.5);
 assert.equal(parse('; estimated printing time = unknown\n').estimated_time,0);
});
test('overridden fields are never evaluated and unsupported numeric ranges reject explicitly',()=>{
 const huge='9'.repeat(400),ignored=`; first_layer_height = ${huge}%\n; total layers count = ${huge}\n; first_layer_temperature = ${huge}\n; filament used [mm] = ${huge}\n`;
 assert.doesNotThrow(()=>parse('','BambuStudio',ignored));assert.doesNotThrow(()=>parse('; estimated printing time = '+huge+'s\n','Slic3r'));
 assert.throws(()=>parse('; first_layer_temperature = '+huge+'\n'),/Nonfinite/);assert.throws(()=>parse('; total layers count = 9007199254740993\n'),/Unsafe/);
});
