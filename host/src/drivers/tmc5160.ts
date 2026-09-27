// TMC5160 startup register plan from klippy/extras/tmc5160.py and tmc.py.
// GPL-3.0-or-later. Current conversion uses GLOBALSCALER and IHOLD_IRUN.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readStepperDistance} from '../config/stepper.ts';
import {tmc5160Current} from './tmc5160-current.ts';
const registers={GLOBALSCALER:0x0b,DRV_CONF:0x0a,CHOPCONF:0x6c,IHOLD_IRUN:0x10,MSLUT0:0x60,MSLUT1:0x61,MSLUT2:0x62,MSLUT3:0x63,MSLUT4:0x64,MSLUT5:0x65,MSLUT6:0x66,MSLUT7:0x67,MSLUTSEL:0x68,MSLUTSTART:0x69,TPWMTHRS:0x13,GCONF:0,TCOOLTHRS:0x14,THIGH:0x15,COOLCONF:0x6d,PWMCONF:0x70,TPOWERDOWN:0x11} as const;
type Register=keyof typeof registers;
const wave=[0xaaaab554,0x4a9554aa,0x24492929,0x10104222,0xfbffffff,0xb5bb777d,0x49295556,0x00404222];
const fields:readonly (readonly [Register,string,number,number,number|boolean])[]=[["GCONF","multistep_filt",3,1,true],["CHOPCONF","toff",0,4,3],["CHOPCONF","hstrt",4,3,5],["CHOPCONF","hend",7,4,2],["CHOPCONF","fd3",11,1,0],["CHOPCONF","disfdcc",12,1,0],["CHOPCONF","chm",14,1,0],["CHOPCONF","tbl",15,2,2],["CHOPCONF","vhighfs",18,1,0],["CHOPCONF","vhighchm",19,1,0],["CHOPCONF","tpfd",20,4,4],["CHOPCONF","diss2g",30,1,0],["CHOPCONF","diss2vs",31,1,0],["COOLCONF","semin",0,4,0],["COOLCONF","seup",5,2,0],["COOLCONF","semax",8,4,0],["COOLCONF","sedn",13,2,0],["COOLCONF","seimin",15,1,0],["COOLCONF","sgt",16,7,0],["COOLCONF","sfilt",24,1,0],["DRV_CONF","drvstrength",18,2,0],["DRV_CONF","bbmclks",8,4,4],["DRV_CONF","bbmtime",0,5,0],["DRV_CONF","filt_isense",20,2,0],["IHOLD_IRUN","iholddelay",16,4,6],["PWMCONF","pwm_ofs",0,8,30],["PWMCONF","pwm_grad",8,8,0],["PWMCONF","pwm_freq",16,2,0],["PWMCONF","pwm_autoscale",18,1,true],["PWMCONF","pwm_autograd",19,1,true],["PWMCONF","freewheel",20,2,0],["PWMCONF","pwm_reg",24,4,4],["PWMCONF","pwm_lim",28,4,12],["TPOWERDOWN","tpowerdown",0,8,10]];
export function planTmc5160(reader:ConfigurationReader,section:string){
 const match=/^tmc5160 (.+)$/.exec(section);if(!match||!reader.hasSection(section)||!reader.hasSection(match[1]))throw new Error('Invalid TMC5160 section');
 const driver=reader.section(section),stepper=readStepperDistance(reader.section(match[1])),mres=Math.log2(256/stepper.microsteps);
 if(!Number.isInteger(mres)||mres<0||mres>8)throw new Error('Invalid TMC microsteps');
 const requestedHold=driver.getFloat('hold_current',{defaultValue:10,above:0,maxval:10}),resistor=driver.getFloat('sense_resistor',{defaultValue:.075,above:0}),current=tmc5160Current(driver.getFloat('run_current',{above:0,maxval:10}),requestedHold,resistor),values=new Map<Register,number>();
 const set=(reg:Register,shift:number,width:number,value:number)=>{const mask=((2**width-1)*2**shift)>>>0;values.set(reg,(((values.get(reg)??0)&~mask)|((value*2**shift)&mask))>>>0);};
 const config=(reg:Register,name:string,shift:number,width:number,fallback:number|boolean)=>{
  const signed=name==='sgt',value=width===1?Number(driver.getBoolean('driver_'+name,{defaultValue:!!fallback})):driver.getInt('driver_'+name,{defaultValue:Number(fallback),minval:signed?-64:0,maxval:signed?63:2**width-1});set(reg,shift,width,value);
 };
 set('GLOBALSCALER',0,8,current.globalscaler);set('IHOLD_IRUN',0,5,current.ihold);set('IHOLD_IRUN',8,5,current.irun);
 set('CHOPCONF',24,4,mres);set('CHOPCONF',28,1,Number(driver.getBoolean('interpolate',{defaultValue:true})));
 for(const [i,value] of wave.entries())config(('MSLUT'+i) as Register,'mslut'+i,0,32,value);
 for(const [name,shift,width,value] of [['w0',0,2,2],['w1',2,2,1],['w2',4,2,1],['w3',6,2,1],['x1',8,8,128],['x2',16,8,255],['x3',24,8,255]] as const)config('MSLUTSEL',name,shift,width,value);
 config('MSLUTSTART','start_sin',0,8,0);config('MSLUTSTART','start_sin90',16,8,247);
 const threshold=(velocity:number|null,fallback:number)=>{if(velocity===null)return fallback;if(velocity===0)return 0xfffff;const n=12000000*(stepper.stepDistance/2**mres)/velocity+.5;if(!Number.isFinite(n))throw new RangeError('TMC threshold arithmetic overflow');return Math.max(0,Math.min(0xfffff,Math.trunc(n)));};
 const stealth=driver.getFloat('stealthchop_threshold',{defaultValue:null,minval:0});set('TPWMTHRS',0,20,threshold(stealth,0xfffff));set('GCONF',2,1,Number(stealth!==null));
 set('TCOOLTHRS',0,20,threshold(driver.getFloat('coolstep_threshold',{defaultValue:null,minval:0}),0));set('THIGH',0,20,threshold(driver.getFloat('high_velocity_threshold',{defaultValue:null,minval:0}),0));
 for(const field of fields)config(...field);
 return Object.freeze({model:'tmc5160' as const,stepper:match[1],current,requestedHold,resistor,microsteps:stepper.microsteps,registers:Object.freeze([...values].map(([name,value])=>Object.freeze({name,address:registers[name],value})))});
}
