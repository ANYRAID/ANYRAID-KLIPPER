// TMC2208/2209 startup fields and current quantization from Klipper's
// tmc2208.py, tmc2209.py, tmc2130.py and tmc.py. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readStepperDistance} from '../config/stepper.ts';
import type {TmcUartDevice} from './tmc-uart.ts';
export function tmc220xCurrent(run:number,hold=2,resistor=.110){
 if(!Number.isFinite(run)||run<0||run>2||!Number.isFinite(hold)||hold<=0||hold>2||!Number.isFinite(resistor)||resistor<=0)throw new RangeError('Invalid TMC current');
 const resistance=resistor+.020;
 const bits=(current:number,vsense:boolean)=>{const scaled=32*resistance*current*Math.SQRT2/(vsense?.18:.32)+.5;if(!Number.isFinite(scaled))throw new RangeError('TMC current arithmetic overflow');return Math.max(0,Math.min(31,Math.trunc(scaled)-1));};
 const amps=(cs:number,vsense:boolean)=>(cs+1)*(vsense?.18:.32)/(32*resistance*Math.SQRT2);
 let vsense=true,irun=bits(run,true);
 if(irun===31&&amps(irun,true)<run){const alternate=bits(run,false);if(Math.abs(run-amps(alternate,false))<Math.abs(run-amps(irun,true))){vsense=false;irun=alternate;}}
 const ihold=bits(Math.min(hold,run),vsense);return Object.freeze({vsense,irun,ihold,runCurrent:amps(irun,vsense),holdCurrent:amps(ihold,vsense)});
}
const registers={GCONF:0,SLAVECONF:3,CHOPCONF:0x6c,IHOLD_IRUN:0x10,TPWMTHRS:0x13,TCOOLTHRS:0x14,COOLCONF:0x42,PWMCONF:0x70,TPOWERDOWN:0x11,SGTHRS:0x40} as const;
type Register=keyof typeof registers;
// register, shift, width, original default. Only original configurable fields.
const fields:readonly (readonly [Register,string,number,number,number|boolean])[]=[
 ['GCONF','multistep_filt',8,1,true],['CHOPCONF','toff',0,4,3],['CHOPCONF','hstrt',4,3,5],['CHOPCONF','hend',7,4,0],['CHOPCONF','tbl',15,2,2],
 ['COOLCONF','semin',0,4,0],['COOLCONF','seup',5,2,0],['COOLCONF','semax',8,4,0],['COOLCONF','sedn',13,2,0],['COOLCONF','seimin',15,1,0],
 ['IHOLD_IRUN','iholddelay',16,4,8],['PWMCONF','pwm_ofs',0,8,36],['PWMCONF','pwm_grad',8,8,14],['PWMCONF','pwm_freq',16,2,1],['PWMCONF','pwm_autoscale',18,1,true],['PWMCONF','pwm_autograd',19,1,true],['PWMCONF','freewheel',20,2,0],['PWMCONF','pwm_reg',24,4,8],['PWMCONF','pwm_lim',28,4,12],['TPOWERDOWN','tpowerdown',0,8,20],['SGTHRS','sgthrs',0,8,0]
];
export function planTmc220x(reader:ConfigurationReader,section:string){
 const match=/^(tmc2208|tmc2209) (.+)$/.exec(section);if(!match||!reader.hasSection(section)||!reader.hasSection(match[2]))throw new Error('Invalid TMC220x section');
 const model=match[1],driver=reader.section(section),stepper=readStepperDistance(reader.section(match[2])),microsteps=stepper.microsteps,mres=Math.log2(256/microsteps);
 if(!Number.isInteger(mres)||mres<0||mres>8)throw new Error('Invalid TMC microsteps');
 const requestedHold=driver.getFloat('hold_current',{defaultValue:2,above:0,maxval:2}),resistor=driver.getFloat('sense_resistor',{defaultValue:.110,above:0});
 const current=tmc220xCurrent(driver.getFloat('run_current',{above:0,maxval:2}),requestedHold,resistor),values=new Map<Register,number>();
 const set=(reg:Register,shift:number,value:number)=>values.set(reg,((values.get(reg)??0)+value*2**shift)>>>0);
 set('GCONF',6,1);if(model==='tmc2209')set('SLAVECONF',8,2);
 set('CHOPCONF',17,Number(current.vsense));set('CHOPCONF',24,mres);set('CHOPCONF',28,Number(driver.getBoolean('interpolate',{defaultValue:true})));
 set('IHOLD_IRUN',0,current.ihold);set('IHOLD_IRUN',8,current.irun);set('GCONF',7,1);
 const threshold=(velocity:number|null,fallback:number)=>{if(velocity===null)return fallback;if(velocity===0)return 0xfffff;const value=12000000*(stepper.stepDistance/2**mres)/velocity+.5;if(!Number.isFinite(value))throw new RangeError('TMC threshold arithmetic overflow');return Math.max(0,Math.min(0xfffff,Math.trunc(value)));};
 const stealth=driver.getFloat('stealthchop_threshold',{defaultValue:null,minval:0});set('TPWMTHRS',0,threshold(stealth,0xfffff));set('GCONF',2,Number(stealth===null));
 if(model==='tmc2209')set('TCOOLTHRS',0,threshold(driver.getFloat('coolstep_threshold',{defaultValue:null,minval:0}),0));
 for(const [reg,name,shift,width,fallback] of fields){if(model==='tmc2208'&&(reg==='COOLCONF'||reg==='SGTHRS'))continue;const value=width===1?Number(driver.getBoolean('driver_'+name,{defaultValue:!!fallback})):driver.getInt('driver_'+name,{defaultValue:Number(fallback),minval:0,maxval:2**width-1});set(reg,shift,value);}
 const address=driver.getInt('uart_address',{defaultValue:0,minval:0,maxval:model==='tmc2209'?3:0});
 return Object.freeze({model,stepper:match[2],address,current,requestedHold,resistor,microsteps,registers:Object.freeze([...values].map(([name,value])=>Object.freeze({name,address:registers[name],value})))});
}
/** Call only with motors disabled. Failure propagates to startup owner; never
 * grants motion readiness or replays a partially initialized driver itself. */
export async function initializeTmc220x(device:TmcUartDevice,plan:ReturnType<typeof planTmc220x>,signal:AbortSignal):Promise<void>{
 for(const register of plan.registers){signal.throwIfAborted();await device.write(register.address,register.value,signal);}
}
