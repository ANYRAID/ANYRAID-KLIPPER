// Firmware stepper configuration derived from klippy/stepper.py, GPL-3.0-or-later.
import {MessageDictionary} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
import type {StepCompressorSettings} from './step-compressor.ts';
export interface StepperConfig<T> {oid:number;step:PinBinding<T>;direction:PinBinding<T>;rotationDistance:number;stepsPerRotation:number;pulseDuration?:number;requestBothEdges?:boolean}
export interface CompiledStepper {
 readonly config:string;readonly restart:string;readonly stepDistance:number;
 readonly pulseDuration:number;readonly bothEdges:boolean;readonly legacyFirmware:boolean;
 readonly compressor:Readonly<Omit<StepCompressorSettings,'timeOffset'|'initialClock'>>;
 readonly resetTag:number;readonly positionQuery:Uint8Array;
}
function constant(dictionary:MessageDictionary,name:string,fallback?:number):number{
 if(!dictionary.hasConstant(name)){if(fallback!==undefined)return fallback;throw new Error(`Missing firmware ${name}`);}
 const raw=dictionary.constant(name);if(typeof raw!=='number'&&(typeof raw!=='string'||!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)))throw new Error(`Invalid firmware ${name}`);
 const value=Number(raw);if(!Number.isFinite(value))throw new Error(`Invalid firmware ${name}`);return value;
}
/** Produces configuration only. Runtime position reconciliation, homing and clock
 * reset boundaries must be completed before activating the generated stepper. */
export function compileStepper<T>(chip:T,dictionary:MessageDictionary,options:StepperConfig<T>):CompiledStepper{
 const {oid,step,direction,rotationDistance,stepsPerRotation}=options;
 if(!Number.isInteger(oid)||oid<0||oid>254||step.chip!==chip||direction.chip!==chip||step.chipName!==direction.chipName)throw new Error('Stepper pins must belong to the configured MCU and a valid OID');
 for(const pin of [step,direction])if(!pin.pin||pin.pin.length>128||/[\s^~!:]/u.test(pin.pin)||pin.pullup!==0||(pin.invert!==0&&pin.invert!==1))throw new Error('Invalid stepper output pin');
 const stepDistance=rotationDistance/stepsPerRotation;
 if(!Number.isFinite(rotationDistance)||rotationDistance<=0||!Number.isFinite(stepsPerRotation)||stepsPerRotation<=0||!Number.isFinite(stepDistance)||stepDistance<=0)throw new RangeError('Invalid stepper distance');
 const frequency=constant(dictionary,'CLOCK_FREQ');if(frequency<=0||frequency>1e9)throw new RangeError('Invalid stepper clock frequency');
 const ssbe=constant(dictionary,'STEPPER_STEP_BOTH_EDGE',0),sbe=constant(dictionary,'STEPPER_BOTH_EDGE',0),sou=constant(dictionary,'STEPPER_OPTIMIZED_UNSTEP',0);
 if([ssbe,sbe,sou].some(n=>!Number.isInteger(n)||n<0))throw new Error('Invalid firmware stepper capabilities');
 let pulseDuration=options.pulseDuration??.000002;
 if(!Number.isFinite(pulseDuration)||pulseDuration<0||pulseDuration>1)throw new RangeError('Invalid step pulse duration');
 const bothEdges=!!options.requestBothEdges&&pulseDuration<=.000000500&&!(sbe&&pulseDuration>.000000150)&&!!(sbe||ssbe)&&!sou;
 if(bothEdges&&sbe)pulseDuration=0;
 const ticks=Math.trunc(pulseDuration*frequency),maxError=Math.trunc(.000025*frequency);
 if(!Number.isSafeInteger(ticks)||ticks>0xffffffff)throw new RangeError('Step pulse clock overflow');
 const config=`config_stepper oid=${oid} step_pin=${step.pin} dir_pin=${direction.pin} invert_step=${bothEdges?-1:step.invert} step_pulse_ticks=${ticks}`;
 const restart=`reset_step_clock oid=${oid} clock=0`;
 const queueStepTag=dictionary.lookup('queue_step oid=%c interval=%u count=%hu add=%hi').id,directionTag=dictionary.lookup('set_next_step_dir oid=%c dir=%c').id,resetTag=dictionary.lookup('reset_step_clock oid=%c clock=%u').id;
 dictionary.lookup('stepper_get_position oid=%c');dictionary.lookup('stepper_position oid=%c pos=%i');
 return Object.freeze({config,restart,stepDistance,pulseDuration,bothEdges,legacyFirmware:!ssbe,compressor:Object.freeze({frequency,oid,maxError,queueStepTag,directionTag,invertDirection:!!direction.invert}),resetTag,positionQuery:dictionary.encode('stepper_get_position',{oid})});
}
