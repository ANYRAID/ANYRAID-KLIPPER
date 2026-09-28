// Servo pulse semantics from klippy/extras/servo.py. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {ConfigurationError} from '../moonraker/config-source.ts';
import type {OutputPinSettings} from './output-pin.ts';
export const SERVO_PERIOD=.020, SERVO_SLACK=.000500;
export interface ServoSettings extends OutputPinSettings {
 readonly minimumPulseWidth:number;readonly maximumPulseWidth:number;readonly maximumAngle:number;
 readonly angleToWidth:number;
}
export function servoAngleValue(settings:ServoSettings,angle:number):number{
 if(!Number.isFinite(angle))throw new RangeError('Invalid servo angle');
 const width=settings.minimumPulseWidth+Math.max(0,Math.min(settings.maximumAngle,angle))*settings.angleToWidth;
 return width*(1/SERVO_PERIOD);
}
export function servoWidthValue(settings:ServoSettings,width:number):number{
 if(!Number.isFinite(width))throw new RangeError('Invalid servo pulse width');
 return (width?Math.max(settings.minimumPulseWidth,Math.min(settings.maximumPulseWidth,width)):0)*(1/SERVO_PERIOD);
}
export function readServo(reader:ConfigurationReader,section:string):Readonly<ServoSettings>{
 if(!/^servo [A-Za-z0-9_][A-Za-z0-9_-]*$/.test(section))throw new ConfigurationError('Invalid servo section name');
 const c=reader.section(section),supported=new Set(['pin','minimum_pulse_width','maximum_pulse_width','maximum_servo_angle','initial_angle','initial_pulse_width']);
 for(const key of Object.keys(c.options()))if(!supported.has(key))throw new ConfigurationError('Unsupported servo option: '+key);
 if(c.hasOption('initial_angle')&&c.hasOption('initial_pulse_width'))throw new ConfigurationError('Choose one servo initial angle or pulse width');
 const pin=c.get('pin');if(!pin||/[\s\0]/u.test(pin))throw new ConfigurationError('Invalid servo pin');
 const minimumPulseWidth=c.getFloat('minimum_pulse_width',{defaultValue:.001,above:0,below:SERVO_PERIOD});
 const maximumPulseWidth=c.getFloat('maximum_pulse_width',{defaultValue:.002,above:minimumPulseWidth,below:SERVO_PERIOD});
 if(maximumPulseWidth<=minimumPulseWidth)throw new ConfigurationError('Servo pulse limits are reversed');
 const maximumAngle=c.getFloat('maximum_servo_angle',{defaultValue:180,above:0});
 const angleToWidth=(maximumPulseWidth-minimumPulseWidth)/maximumAngle;
 if(!Number.isFinite(angleToWidth)||angleToWidth<=0)throw new ConfigurationError('Servo angle conversion is unrepresentable');
 const settings:ServoSettings={section,name:section.slice(6),pin,pwm:true,hardware:false,cycleTime:SERVO_PERIOD,scale:1,
  initialValue:0,shutdownValue:0,minimumPulseWidth,maximumPulseWidth,maximumAngle,angleToWidth};
 const initialValue=c.hasOption('initial_angle')?servoAngleValue(settings,c.getFloat('initial_angle',{minval:0,maxval:360}))
  :servoWidthValue(settings,c.getFloat('initial_pulse_width',{defaultValue:0,minval:0,maxval:maximumPulseWidth}));
 return Object.freeze({...settings,initialValue});
}
