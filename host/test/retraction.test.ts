import test from 'node:test';
import assert from 'node:assert/strict';
import {FirmwareRetraction} from '../src/gcode/retraction.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {readRetraction} from '../src/config/retraction.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
const settings={retract_length:.1,retract_speed:20.019,unretract_extra_length:.01,unretract_speed:10},signal=()=>new AbortController().signal;
test('typed retraction preserves modes, overrides and user macro storage',()=>{
 const moves:{p:readonly number[];speed:number}[]=[],g=new GCodeMove({position:()=>[1,2,3,4],move:(p,speed)=>{moves.push({p,speed});}}),r=new FirmwareRetraction(settings);
 g.execute('G92',{E:0});g.execute('M220',{S:50});g.execute('M221',{S:200});g.execute('M83');g.execute('SAVE_GCODE_STATE',{NAME:'_retract_state'});const before=g.state;
 r.move(g,true);r.move(g,true);r.move(g,false);r.move(g,false);assert.equal(moves.length,2);assert.equal(moves[0].speed,1201/120);assert.equal(moves[0].p[3],3.8);assert.equal(g.state.position[3],4.02);assert.deepEqual(g.gcodePosition,[1,2,3,0]);assert.equal(g.state.speed,before.speed);assert.equal(g.state.absoluteExtrude,false);
 g.execute('G90');g.execute('RESTORE_GCODE_STATE',{NAME:'_retract_state'});assert.equal(g.state.absoluteExtrude,false);assert.equal(g.state.speed,before.speed);
});
test('rejected motion keeps coordinate state and retraction latch unchanged',()=>{
 let reject=true;const g=new GCodeMove({position:()=>[0,0,0,0],move:()=>{if(reject)throw Error('thermal guard');}}),r=new FirmwareRetraction(settings),before=g.state;
 assert.throws(()=>r.move(g,true),/thermal/);assert.deepEqual(g.state,before);assert.equal(r.retracted,false);reject=false;r.move(g,true);reject=true;const retracted=g.state;assert.throws(()=>r.move(g,false));assert.deepEqual(g.state,retracted);assert.equal(r.retracted,true);
});
test('settings validation is atomic and successful updates reset the latch',async()=>{
 const g=new GCodeMove({position:()=>[0,0,0,0],move:()=>{}}),r=new FirmwareRetraction(settings),output:string[]=[],d=new GCodeDispatch({output:s=>output.push(s),shutdown:()=>{}});r.register(d,g);d.setReady(true);await d.execute('G10');
 await assert.rejects(d.execute('SET_RETRACTION RETRACT_LENGTH=1 UNRETRACT_SPEED=0'));assert.deepEqual(r.status,settings);assert.equal(r.retracted,true);
 await assert.rejects(d.execute('SET_RETRACTION RETRACT_SPEED=1e308'));await d.execute('SET_RETRACTION RETRACT_LENGTH=0.2\nGET_RETRACTION');assert.equal(r.retracted,false);assert(output.join('').includes('RETRACT_LENGTH=0.20000 RETRACT_SPEED=20.01900'));
});
test('optional firmware retraction configuration validates before hardware ownership',()=>{
 const read=(sections:Record<string,Record<string,string>>)=>readRetraction(new ConfigurationReader(new ConfigurationSource('/retract.cfg',sections,[]),null));assert.equal(read({}),undefined);assert.deepEqual(read({firmware_retraction:{}}),{retract_length:0,retract_speed:20,unretract_extra_length:0,unretract_speed:10});for(const v of ['-1','nan','inf'])assert.throws(()=>read({firmware_retraction:{retract_length:v}}));assert.throws(()=>read({firmware_retraction:{retract_speed:'.5'}}));
});
test('native retraction cannot bypass cold extrusion protection',async()=>{
 const f=await nativeLinearFixture();try{f.kinematics.markHomed([0,1,2]);const g=new GCodeMove(f.port),r=new FirmwareRetraction(settings);assert.throws(()=>r.move(g,true),/temperature/);assert.equal(r.retracted,false);assert.equal(f.port.status.pendingMoves,0);}finally{await f.close();}
});
test('native file accepts retraction pairs and preserves subsequent absolute E coordinates',async()=>{
 const f=await nativePrintFixture('G10\nG10\nG11\nG11\nG1 X51 E2.01 F600\n',false,false,false,1,settings),owner=await createNativeLinearPrint(f.options),eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(eof.reject);void eof.promise.catch(()=>{});
 try{await owner.device.prepare({version:1,requestId:'retract',fileId:'file',nozzle:200,bed:60},signal());await owner.device.start('file',signal());await eof.promise;await owner.device.finish('retract',signal());assert.equal(f.gcode.retraction!.retracted,false);assert.equal(f.gcode.coordinates.state.position[0],51);assert(Math.abs(f.gcode.coordinates.state.position[3]-2.02)<1e-14);assert.equal(f.outputStops,0);}finally{await owner.close();await f.close();}
});
