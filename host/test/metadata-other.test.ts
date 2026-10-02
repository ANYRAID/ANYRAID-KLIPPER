import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseOtherMetadata,type OtherFamily} from '../src/moonraker/metadata-other.ts';
import {extractSlicerFields,detectSlicerObjects} from '../src/moonraker/metadata-fields.ts';
import {roundMetadataDecimal} from '../src/moonraker/metadata-values.ts';
const parse=(family:OtherFamily,header:string,footer='',version='?')=>parseOtherMetadata({header,footer,size:Buffer.byteLength(header+footer)},family,version);
test('Cura converts each length before compensated sum and uses maximal time',()=>{
 const fields=parse('Cura',';Filament used: 1.25m, 2.5m\n;Filament weight = [1.5, 2.5]\n;TIME:100\n;TIME:120\n;LAYER_COUNT:12\n');assert.equal(fields.filament_total,3750);assert.deepEqual(fields.filament_weights,[1.5,2.5]);assert.equal(fields.filament_weight_total,4);assert.equal(fields.estimated_time,120);assert.equal(fields.layer_count,12);
});
test('Simplify3D version selects exact heater names or multiline v5 controller blocks',()=>{
 const h='; temperatureName,Extruder 1,Heated Bed\n; temperatureSetpointTemperatures,２.１e2,+6_0\n; temperatureController,tool\n; temperatureType,extruder\n; temperatureSetpoints,1|220\n; temperatureController,bed\n; temperatureType,platform\n; temperatureSetpoints,1|65\n';
 assert.equal(parse('Simplify3D',h,'','4').first_layer_extr_temp,210);assert.equal(parse('Simplify3D',h,'','4').first_layer_bed_temp,60);assert.equal(parse('Simplify3D',h,'','5').first_layer_extr_temp,220);assert.equal(parse('Simplify3D',h,'','5').first_layer_bed_temp,65);
 assert.equal(parse('Simplify3D','temperatureName,Extruder 1\ntemperatureSetpointTemperatures,broken\n','','4').first_layer_extr_temp,undefined);
 assert.equal(parse('Simplify3D','','; Build Time: 1 hour 2 min 3 sec\n').estimated_time,3723);
});
test('KISSlicer minutes round ties to even after multiplication; IceSL fields use header',()=>{
 assert.equal(roundMetadataDecimal(2.675,2),2.67);assert.equal(roundMetadataDecimal(-2.675,2),-2.67);
 assert.equal(parse('KISSlicer','','; Calculated Build Time: 1.2345 minutes\n').estimated_time,74.07);
 assert.equal(parse('IceSL','; print_height_mm : 12.5\n; layer_count : 100\n','; print_height_mm : 99\n').object_height,12.5);
});
test('IdeaMaker preserves final bounding-box capture, empty weight sum and mismatched lists',()=>{
 assert.equal(parse('IdeaMaker','').filament_weight_total,0);
 assert.equal(parse('IdeaMaker',';Bounding Box: 0 1 2 3 4 25.5\n').object_height,25.5);
 assert.equal(parse('IdeaMaker',';Filament Diameter #0: 1.75\n',';Material#0 Used: 1000\n').filament_weight_total,undefined);
 const fields=parse('IdeaMaker',';Filament Diameter #0: 1.75\n;Filament Density #0: 1240\n',';Material\u20280 Used: 1000\n');assert.equal(fields.filament_total,1000);assert.ok(Math.abs(Number(fields.filament_weight_total)-2.9825495255018097)<1e-14);
});
test('KiriMoto takes last layer rather than maximum and does not count arbitrary Z hops',()=>{
 const fields=parse('KiriMoto','',';; --- layer 8 (a)\n;; --- layer ٢ (b)\nG1 Z20 ; z-hop start\nG1 Z10 ; z-hop end\nG1 Z12 F1200\n; --- print time: 200s\n');assert.equal(fields.layer_count,3);assert.equal(fields.object_height,12);assert.equal(fields.estimated_time,200);
 assert.throws(()=>parse('KiriMoto','',';; --- layer 9007199254740991 (x)\n'),/Unsafe/);
});
test('field dispatch identifies only original byte header and object detection does not reprocess files',()=>{
 const window={identificationHeader:'Cura_SteamEngine 5.0',header:';MINZ:.2\n',footer:'; BambuStudio 2\n',size:100,modified:1};const fields=extractSlicerFields(window);assert.equal(fields.slicer,'Cura');assert.equal(fields.first_layer_height,.2);assert.equal(fields.modified,1);
 assert.deepEqual(detectSlicerObjects('\n;MESH:one\nM486 S0','Cura'),{hasObjects:true,hasM486Objects:true});assert.deepEqual(detectSlicerObjects('\nM486 S0\nEXCLUDE_OBJECT_DEFINE NAME=x','Cura'),{hasObjects:false,hasM486Objects:false});assert.equal(detectSlicerObjects(';MESH:one','Cura').hasObjects,false);assert.equal(detectSlicerObjects('\n; printing object one','BambuStudio').hasObjects,true);
});
