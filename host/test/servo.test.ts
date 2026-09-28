import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {readServo,servoAngleValue,servoWidthValue} from '../src/config/servo.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {bindServoCommands} from '../src/gcode/servo.ts';
const reader=(options:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/servo.cfg',{'servo gate':{pin:'PA2',...options}},[]),null);
test('servo angle and width conversion match fixed original Python method results exactly',()=>{
 const reference=JSON.parse(gunzipSync(readFileSync(new URL('../contracts/servo-reference.json.gz',import.meta.url))).toString()) as {cases:{minimum:number;maximum:number;angle:number;angles:number[][];widths:number[][]}[]};
 let count=0;
 for(const c of reference.cases){
  const settings=readServo(reader({minimum_pulse_width:String(c.minimum),maximum_pulse_width:String(c.maximum),maximum_servo_angle:String(c.angle)}),'servo gate');
  for(const [angle,value] of c.angles){assert.equal(servoAngleValue(settings,angle),value);count++;}
  for(const [width,value] of c.widths){assert.equal(servoWidthValue(settings,width),value);count++;}
 }
 assert.equal(count,1575);
});
test('servo defaults distinguish angle zero from pulses off and reject ambiguous or unrepresentable configuration',()=>{
 const base=readServo(reader(),'servo gate');assert.equal(base.cycleTime,.020);assert.equal(base.initialValue,0);assert.equal(base.shutdownValue,0);
 assert.equal(servoAngleValue(base,0),.05);assert.equal(servoAngleValue(base,180),.1);assert.equal(servoWidthValue(base,0),0);
 assert.equal(readServo(reader({initial_angle:'90'}),'servo gate').initialValue,.075);
 for(const options of [{maximum_servo_angle:'0'},{minimum_pulse_width:'.003'}, {maximum_pulse_width:'.020'}, {initial_angle:'361'}, {initial_angle:'90',initial_pulse_width:'.001'}, {maximum_servo_angle:'1e-320'}, {hardware_pwm:'true'}] as Record<string,string>[]){assert.throws(()=>readServo(reader(options),'servo gate'));}
 for(const value of [NaN,Infinity,-Infinity]){assert.throws(()=>servoAngleValue(base,value));assert.throws(()=>servoWidthValue(base,value));}
});
test('servo commands accept exactly one finite angle or width and validate before queueing',async()=>{
 const values:number[]=[],dispatch=new GCodeDispatch({output(){},shutdown(){}});
 bindServoCommands(dispatch,[readServo(reader(),'servo gate')],async(_name,value)=>{values.push(value);});dispatch.setReady(true);
 await dispatch.execute('SET_SERVO SERVO=gate ANGLE=90\nSET_SERVO SERVO=gate WIDTH=0');assert.deepEqual(values,[.075,0]);
 for(const command of ['SET_SERVO SERVO=gate','SET_SERVO SERVO=gate ANGLE=90 WIDTH=.001','SET_SERVO SERVO=missing ANGLE=0','SET_SERVO SERVO=gate ANGLE=nan','SET_SERVO SERVO=gate ANGLE=90 TEMPLATE=x'])await assert.rejects(dispatch.execute(command));
 assert.deepEqual(values,[.075,0]);
});
