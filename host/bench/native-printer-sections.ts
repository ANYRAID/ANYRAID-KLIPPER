import {validateNativePrinterSections} from '../src/config/native-printer-sections.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const sections=['printer','mcu','mcu aux','extruder','heater_bed','verify_heater extruder','verify_heater heater_bed','bed_mesh','bed_mesh saved','input_shaper','idle_timeout','safe_z_home','probe','fan','heater_fan hotend','controller_fan board','board_pins',...['x','y','z'].flatMap(a=>['stepper_'+a,'tmc2209 stepper_'+a,'endstop_phase stepper_'+a]),...Array.from({length:16},(_,i)=>'fan_generic auxiliary'+i)];
const r=new ConfigurationReader(new ConfigurationSource('/bench.cfg',Object.fromEntries(sections.map(s=>[s,{}])),[]),null),times=[];
for(let batch=0;batch<9;batch++){const start=performance.now();for(let i=0;i<10000;i++)validateNativePrinterSections(r);if(batch>=2)times.push(performance.now()-start);}
times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,sections:sections.length,iterations:10000,warmups:2,samples:7,medianMs:times[3],maxMs:times[6],scope:'Startup-only section validation; excludes full option/hardware validation and is not on motion scheduling path.'}));
