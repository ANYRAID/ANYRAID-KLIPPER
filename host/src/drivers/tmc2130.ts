// TMC2130 startup register plan from klippy/extras/tmc2130.py and tmc.py.
// GPL-3.0-or-later. Current conversion is shared with TMC2208/2209.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readStepperDistance} from '../config/stepper.ts';
import {tmc220xCurrent} from './tmc220x.ts';
const registers={CHOPCONF:0x6c,IHOLD_IRUN:0x10,MSLUT0:0x60,MSLUT1:0x61,MSLUT2:0x62,MSLUT3:0x63,MSLUT4:0x64,MSLUT5:0x65,MSLUT6:0x66,MSLUT7:0x67,MSLUTSEL:0x68,MSLUTSTART:0x69,TPWMTHRS:0x13,GCONF:0,TCOOLTHRS:0x14,THIGH:0x15,COOLCONF:0x6d,PWMCONF:0x70,TPOWERDOWN:0x11} as const;
type Register=keyof typeof registers;
const wave=[0xaaaab554,0x4a9554aa,0x24492929,0x10104222,0xfbffffff,0xb5bb777d,0x49295556,0x00404222];
const fields:readonly (readonly [Register,string,number,number,number|boolean])[]=[
 ['CHOPCONF','toff',0,4,4],['CHOPCONF','hstrt',4,3,0],['CHOPCONF','hend',7,4,7],['CHOPCONF','tbl',15,2,1],['CHOPCONF','vhighfs',18,1,false],['CHOPCONF','vhighchm',19,1,false],
 ['COOLCONF','semin',0,4,0],['COOLCONF','seup',5,2,0],['COOLCONF','semax',8,4,0],['COOLCONF','sedn',13,2,0],['COOLCONF','seimin',15,1,false],['COOLCONF','sgt',16,7,0],['COOLCONF','sfilt',24,1,false],
 ['IHOLD_IRUN','iholddelay',16,4,8],['PWMCONF','pwm_ampl',0,8,128],['PWMCONF','pwm_grad',8,8,4],['PWMCONF','pwm_freq',16,2,1],['PWMCONF','pwm_autoscale',18,1,true],['PWMCONF','freewheel',20,2,0],['TPOWERDOWN','tpowerdown',0,8,0]
];
export function planTmc2130(reader:ConfigurationReader,section:string){
 const match=/^tmc2130 (.+)$/.exec(section);if(!match||!reader.hasSection(section)||!reader.hasSection(match[1]))throw new Error('Invalid TMC2130 section');
 const driver=reader.section(section),stepper=readStepperDistance(reader.section(match[1])),mres=Math.log2(256/stepper.microsteps);
 if(!Number.isInteger(mres)||mres<0||mres>8)throw new Error('Invalid TMC microsteps');
 const requestedHold=driver.getFloat('hold_current',{defaultValue:2,above:0,maxval:2}),resistor=driver.getFloat('sense_resistor',{defaultValue:.110,above:0}),current=tmc220xCurrent(driver.getFloat('run_current',{above:0,maxval:2}),requestedHold,resistor),values=new Map<Register,number>();
 const set=(reg:Register,shift:number,width:number,value:number)=>{const mask=((2**width-1)*2**shift)>>>0;values.set(reg,(((values.get(reg)??0)&~mask)|((value*2**shift)&mask))>>>0);};
 const config=(reg:Register,name:string,shift:number,width:number,fallback:number|boolean)=>{
  const signed=name==='sgt',value=width===1?Number(driver.getBoolean('driver_'+name,{defaultValue:!!fallback})):driver.getInt('driver_'+name,{defaultValue:Number(fallback),minval:signed?-64:0,maxval:signed?63:2**width-1});set(reg,shift,width,value);
 };
 set('CHOPCONF',17,1,Number(current.vsense));set('IHOLD_IRUN',0,5,current.ihold);set('IHOLD_IRUN',8,5,current.irun);
 set('CHOPCONF',24,4,mres);set('CHOPCONF',28,1,Number(driver.getBoolean('interpolate',{defaultValue:true})));
 for(const [i,value] of wave.entries())config(('MSLUT'+i) as Register,'mslut'+i,0,32,value);
 for(const [name,shift,width,value] of [['w0',0,2,2],['w1',2,2,1],['w2',4,2,1],['w3',6,2,1],['x1',8,8,128],['x2',16,8,255],['x3',24,8,255]] as const)config('MSLUTSEL',name,shift,width,value);
 config('MSLUTSTART','start_sin',0,8,0);config('MSLUTSTART','start_sin90',16,8,247);
 const threshold=(velocity:number|null,fallback:number)=>{if(velocity===null)return fallback;if(velocity===0)return 0xfffff;const n=13200000*(stepper.stepDistance/2**mres)/velocity+.5;if(!Number.isFinite(n))throw new RangeError('TMC threshold arithmetic overflow');return Math.max(0,Math.min(0xfffff,Math.trunc(n)));};
 const stealth=driver.getFloat('stealthchop_threshold',{defaultValue:null,minval:0});set('TPWMTHRS',0,20,threshold(stealth,0xfffff));set('GCONF',2,1,Number(stealth!==null));
 set('TCOOLTHRS',0,20,threshold(driver.getFloat('coolstep_threshold',{defaultValue:null,minval:0}),0));set('THIGH',0,20,threshold(driver.getFloat('high_velocity_threshold',{defaultValue:null,minval:0}),0));
 for(const field of fields)config(...field);
 return Object.freeze({model:'tmc2130' as const,stepper:match[1],current,requestedHold,resistor,microsteps:stepper.microsteps,registers:Object.freeze([...values].map(([name,value])=>Object.freeze({name,address:registers[name],value})))});
}
