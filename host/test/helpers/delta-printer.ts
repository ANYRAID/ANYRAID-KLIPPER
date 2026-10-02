export function deltaPrinterSections(original:Record<string,Record<string,string>>){
 const raw=structuredClone(original);
 for(const [axis,tower] of [['x','a'],['y','b'],['z','c']]){raw[`stepper_${tower}`]={...raw[`stepper_${axis}`],position_endstop:'300'};delete raw[`stepper_${axis}`];}
 Object.assign(raw.printer,{kinematics:'delta',delta_radius:'100'});raw.stepper_a.arm_length='250';
 Object.assign(raw.stepper_b,{step_pin:'aux:PA6',dir_pin:'aux:PA7',endstop_pin:'aux:PA8',enable_pin:'!aux:PA9'});
 return raw;
}
