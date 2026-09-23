import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {readStepperDistance,compileConfiguredStepper} from '../src/config/stepper.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
const reader=(values:Record<string,string>={rotation_distance:'40',microsteps:'16'})=>new ConfigurationReader(new ConfigurationSource('/stepper.cfg',{stepper_x:values},[]),null),read=(values:Record<string,string>)=>readStepperDistance(reader(values).section('stepper_x'));
test('linear step distance preserves defaults and fractional multi-stage gearing order',()=>{
 const plain=read({rotation_distance:'40',microsteps:'16'});assert.equal(plain.fullSteps,200);assert.equal(plain.stepsPerRotation,3200);assert.equal(plain.stepDistance,.0125);
 const geared=read({rotation_distance:'22.6789511',microsteps:'16',gear_ratio:'50:17, 3:2'});assert.equal(geared.stepsPerRotation,3200*((50/17)*(3/2)));assert.equal(geared.stepDistance,22.6789511/geared.stepsPerRotation);
 assert.equal(read({rotation_distance:'40',microsteps:'3',full_steps_per_rotation:'400'}).stepsPerRotation,1200);
});
test('angular distance is explicit while diagnostic inference matches missing linear distance',()=>{
 const section=reader({microsteps:'16',gear_ratio:'80:16'}).section('stepper_x');assert.throws(()=>readStepperDistance(section,false));assert.equal(readStepperDistance(section,null).rotationDistance,2*Math.PI);assert.equal(readStepperDistance(section,true).stepsPerRotation,16000);
 assert.throws(()=>readStepperDistance(reader().section('stepper_x'),true),/requires gear_ratio/);assert.equal(readStepperDistance(reader().section('stepper_x'),null).unitsInRadians,false);
});
test('invalid resolution and gears reject before any firmware lookup',()=>{
 const cases:Record<string,string>[]=[{microsteps:'0'},{full_steps_per_rotation:'201'},{microsteps:'9007199254740991'},{gear_ratio:'1:0'},{gear_ratio:'-1:-2'},{gear_ratio:'1::2'},{gear_ratio:'1:2:3'},{gear_ratio:'1e308:1,1e308:1'},{gear_ratio:'1:1e308,1:1e308'},{rotation_distance:'5e-324'}];
 for(const extra of cases){
  const r=reader({rotation_distance:'40',microsteps:'16',...extra});let touched=false;assert.throws(()=>compileConfiguredStepper(r,'stepper_x',{},new Proxy({},{get(){touched=true;throw new Error('dictionary touched');}}) as MessageDictionary,{} as never));assert.equal(touched,false);
 }
});
test('configured firmware plan uses derived step distance and bounded configured pulse width',()=>{
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{'queue_step oid=%c interval=%u count=%hu add=%hi':2,'set_next_step_dir oid=%c dir=%c':3,'reset_step_clock oid=%c clock=%u':4,'stepper_get_position oid=%c':5},responses:{'stepper_position oid=%c pos=%i':6},config:{CLOCK_FREQ:1e6}})),false);
 const chip={},bindings={oid:3,step:{chip,chipName:'m',pin:'PA0',invert:0 as const,pullup:0 as const},direction:{chip,chipName:'m',pin:'PA1',invert:1 as const,pullup:0 as const}};
 const plan=compileConfiguredStepper(reader({rotation_distance:'40',microsteps:'16',gear_ratio:'80:16',step_pulse_duration:'.000003'}),'stepper_x',chip,dictionary,bindings);assert.equal(plan.stepDistance,.0025);assert.equal(plan.stepsPerRotation,16000);assert.match(plan.config,/step_pulse_ticks=3/);assert.equal(plan.compressor.invertDirection,true);
 assert.throws(()=>compileConfiguredStepper(reader({rotation_distance:'40',microsteps:'16',step_pulse_duration:'.0011'}),'stepper_x',chip,dictionary,bindings));
});
function configuredStepTrace(configured:boolean){
 const distance=configured?read({rotation_distance:'40',microsteps:'16',gear_ratio:'80:16'}).stepDistance:1/400;
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]));using s=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',distance);s.generate(2);return s.flush();
}
test('geared config produces identical native pulse clocks and positions to independent distance',()=>{
 const actual=configuredStepTrace(true),reference=configuredStepTrace(false);assert.equal(actual.position,3600n);assert.deepEqual(actual,reference);
});
