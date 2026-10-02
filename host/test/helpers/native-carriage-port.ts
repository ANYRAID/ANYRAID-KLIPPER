import {rebuiltFixture} from './rebuilt-motion.ts';
import {bindRebuiltMotion} from '../../src/runtime/rebuilt-motion.ts';
import {readLinearMotionConfiguration} from '../../src/config/linear-motion.ts';
import {linearMotionReader} from './linear-motion-config.ts';
import {NativeLinearHomingPort} from '../../src/homing/native-linear-port.ts';
import {DualCarriageLinearKinematics} from '../../src/kinematics/dual-carriage-linear.ts';
import {nativeCarriageTransforms} from '../../src/kinematics/dual-carriage-projection.ts';
export async function nativeCarriageFixture(reverse=false,retractDistance=0){
 const initial=[{mode:'PRIMARY',scale:1,offset:0},{mode:'INACTIVE',scale:0,offset:180}] as const,geometry={kind:'cartesian',axis:0,rails:[{minimum:0,maximum:200,endstop:reverse?200:0,positiveDirection:reverse},{minimum:10,maximum:220,endstop:220,positiveDirection:true}],safeDistance:10} as const;
 const transforms=nativeCarriageTransforms(geometry,initial),f=await rebuiltFixture(true,true,false,false,false,0,transforms.map((transform,i)=>({id:i?'x2':'x',transform})));
 try{
  const generation=await bindRebuiltMotion(f.options),config=readLinearMotionConfiguration(linearMotionReader()),kinematics=new DualCarriageLinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100},geometry,initial);
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}],second=[{...groups[0],endstop:f.secondEndstop,members:[{...groups[0].members[0],trigger:f.secondTrigger}]}];
  const port=new NativeLinearHomingPort({generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[groups,groups,groups],carriages:{homingRails:geometry.rails.map((r,i)=>({...r,speed:100,secondSpeed:retractDistance?5:50,retractSpeed:100,retractDistance,endstops:[i?'second':'first']})) as unknown as readonly [import('../../src/homing/linear-command.ts').LinearHomingRail,import('../../src/homing/linear-command.ts').LinearHomingRail],emitterIds:['x','x2'],groups:[groups,second]},limits:config.limits,extrusion:config.extrusion,canExtrude:()=>false});
  return {f,port,kinematics,async close(){await port.dispose();await f.close();}};
 }catch(e){await f.close();throw e;}
}
