import {ConfigurationReader} from '../../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../../src/moonraker/config-source.ts';
import {compileConfiguredHardware,type HardwareLayout} from '../../src/config/hardware.ts';
import {compileConfiguredMotionEmitters,type ConfiguredMotionRequest} from '../../src/config/motion-emitters.ts';
import {hardwareFixture,hardwareClocks} from './configured-hardware.ts';
import type {StoppedEmitter} from '../../src/homing/rebuild-motion.ts';
import {TrapQueue} from '../../src/motion/trap-queue.ts';
export const motionRequests:readonly ConfiguredMotionRequest[]=[{emitter:'x',queueId:'xyz',mode:'x'},{emitter:'e',queueId:'e',mode:'extruder'}];
export function configuredMotionFixture(shaper:Record<string,string>={},extruder:Record<string,string>={}){
 const reader=new ConfigurationReader(new ConfigurationSource('/motion.cfg',{stepper_x:{step_pin:'PA0',dir_pin:'!PA1',rotation_distance:'40',microsteps:'16'},extruder:{step_pin:'aux:PA0',dir_pin:'aux:PA1',rotation_distance:'40',microsteps:'16',pressure_advance:'.05',...extruder},input_shaper:{shaper_type:'mzv',shaper_freq_x:'40',...shaper}},[]),null);
 const f=hardwareFixture(),clocks=hardwareClocks();clocks.get('mcu')!.calibration={offset:.01,frequency:1000000.25};clocks.get('aux')!.calibration={offset:.02,frequency:999999.75};
 const layout:HardwareLayout={steppers:[{section:'stepper_x',emitter:'x',enableLeadTime:.001},{section:'extruder',emitter:'e',enableLeadTime:.001}],homing:[],fans:[],heaters:[]},hardware=compileConfiguredHardware(reader,f.group,clocks,layout);
 return {reader,hardware,requests:motionRequests,emitters:()=>compileConfiguredMotionEmitters(reader,hardware,motionRequests)};
}
export function generateConfiguredEmitter(e:StoppedEmitter){
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,e.mode==='extruder'?1:0,0,0,10,100,2,0,.1,0,9,0,0,0,0,0,0,0,0]));
 using s=q.createStepper(e.settings,e.mode,e.rotationDistance/e.stepsPerRotation);
 if(e.shapers)s.configureShapers(e.shapers);if(e.pressureAdvance)s.configurePressureAdvance(e.pressureAdvance.advance,e.pressureAdvance.smoothTime);
 s.generate(2.05);return s.flush();
}
