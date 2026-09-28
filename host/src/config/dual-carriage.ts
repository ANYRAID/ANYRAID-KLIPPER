import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {LinearConfig} from '../kinematics/linear.ts';
import {carriageHomingOrder,carriageSafeDistance,type CarriageRail} from '../kinematics/dual-carriage.ts';
import type {LinearHomingRail} from '../homing/linear-command.ts';
export interface DualCarriageConfiguration {
 readonly kind:'cartesian'|'hybrid_corexy'|'hybrid_corexz';readonly axis:0|1;
 readonly rails:readonly [CarriageRail,CarriageRail];readonly safeDistance:number;
 readonly homingOrder:readonly [0|1,0|1];readonly secondHoming:Omit<LinearHomingRail,'endstops'>;
}
/** Geometry only. Parsing never authorizes native startup or grants homing. */
export function readDualCarriage(reader:ConfigurationReader,kind:LinearConfig['kind'],ranges:LinearConfig['ranges'],homing:readonly Omit<LinearHomingRail,'endstops'>[]):DualCarriageConfiguration|undefined{
 if(!reader.hasSection('dual_carriage'))return undefined;
 if(kind!=='cartesian'&&kind!=='hybrid_corexy'&&kind!=='hybrid_corexz')throw new Error('Dual carriage requires Cartesian or hybrid Core kinematics');
 const s=reader.section('dual_carriage'),name=kind==='cartesian'?s.getChoice('axis',['x','y']):s.getChoice('axis',['x'],{defaultValue:'x'}),axis=name==='x'?0:1;
 const minimum=s.getFloat('position_min',{defaultValue:0}),maximum=s.getFloat('position_max',{above:minimum}),endstop=s.getFloat('position_endstop',{minval:minimum,maxval:maximum}),length=maximum-minimum;
 if(!Number.isFinite(length))throw new RangeError('Dual carriage rail overflow');
 let positiveDirection=s.getBoolean('homing_positive_dir',{defaultValue:null});
 if(positiveDirection===null){if(endstop<=minimum+length/4)positiveDirection=false;else if(endstop>=maximum-length/4)positiveDirection=true;else throw new Error('Unable to infer dual carriage homing direction');}
 if(positiveDirection&&endstop===minimum||!positiveDirection&&endstop===maximum)throw new Error('Dual carriage homing direction conflicts with endstop');
 const speed=s.getFloat('homing_speed',{defaultValue:5,above:0}),secondSpeed=s.getFloat('second_homing_speed',{defaultValue:speed/2,above:0}),retractSpeed=s.getFloat('homing_retract_speed',{defaultValue:speed,above:0}),retractDistance=s.getFloat('homing_retract_dist',{defaultValue:5,minval:0});
 const force=positiveDirection?endstop-1.5*(endstop-minimum):endstop+1.5*(maximum-endstop);
 if(![speed,secondSpeed,retractSpeed].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(force)||force===endstop)throw new RangeError('Unrepresentable dual carriage homing configuration');
 const primary=homing[axis];if(!primary)throw new Error('Missing primary carriage homing');
 const rails=Object.freeze([Object.freeze({minimum:ranges[axis][0],maximum:ranges[axis][1],endstop:primary.endstop,positiveDirection:primary.positiveDirection}),Object.freeze({minimum,maximum,endstop,positiveDirection})] as const);
 const safeDistance=carriageSafeDistance(rails,s.getFloat('safe_distance',{defaultValue:null,minval:0})??undefined),homingOrder=Object.freeze(carriageHomingOrder(rails));
 return Object.freeze({kind,axis,rails,safeDistance,homingOrder,secondHoming:Object.freeze({endstop,positiveDirection,speed,secondSpeed,retractSpeed,retractDistance})});
}
