import {compileConfiguredSpiHeaters} from './spi-heater.ts';
import {compileConfiguredSpiSensors} from './spi-temperature.ts';
import {readHostTemperature} from '../thermal/host-temperature.ts';
import {compileConfiguredAnalogSensors} from './analog-sensor.ts';
import {compileConfiguredBLTouch} from './bltouch.ts';
import {compileConfiguredTmcSpi} from './tmc-spi.ts';
import {compileConfiguredTmcUart} from './tmc-uart.ts';
import {applyConfiguredBoardPins} from './board-pins.ts';
import {PrintClockTimeline,readPrintClock} from '../timing/print-clock-timeline.ts';
import {SecondarySync} from '../timing/secondary-sync.ts';
// Cold-start hardware assembly. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUGroup} from '../runtime/mcu-group.ts';
import type {MCUConfigPlan} from '../protocol/mcu-config.ts';
import {PrinterPins} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import {compileConfiguredSteppers,type StepperSectionRequest} from './stepper.ts';
import {compileConfiguredMotorEnables} from './motor-enable.ts';
import {compileConfiguredHoming} from './homing.ts';
import {compileConfiguredCoolingFans,type CoolingFanRequest,type FanClock} from './cooling-fan.ts';
import {compileConfiguredAnalogHeaters} from './analog-heater.ts';
import {compileConfiguredButtons} from './buttons.ts';
export interface HardwareLayout {
 steppers:readonly (Omit<StepperSectionRequest,'oid'>&{emitter:string;enableLeadTime:number})[];
 /** Explicit physical membership; homing runtime still binds its emitters. */
 homing:readonly {section:string;mcus:readonly string[]}[];
 fans:readonly Omit<CoolingFanRequest,'oid'|'enableOid'>[];
 heaters:readonly {section:string}[];
 sensors?:readonly {section:string}[];
 buttons?:readonly {section:string}[];
 boards?:readonly {mcu:string;aliases?:Readonly<Record<string,string>>;reserved?:readonly string[]}[];
}
/** No MCU IO. A fresh private resource registry makes failures across device
 * kinds atomic: no partial pin/OID ownership escapes a rejected assembly.
 * Plans include every connected MCU, including zero-device controllers.
 * Subscribe ADC consumers before submitting these plans; start outputs only
 * after every MCU is configured. This does not grant homing authority. */
export function compileConfiguredHardware(reader:ConfigurationReader,group:MCUGroup,clocks:ReadonlyMap<string,FanClock>,layout:HardwareLayout){
 group.assertActive();
 const devices=group.status.devices,mcus=new Map(devices.map(({id})=>{const session=group.session(id);if(session.status.configured)throw new Error('Hardware assembly requires unconfigured MCU sessions');return [id,{chip:session,dictionary:session.dictionary}] as const;}));
 const pins=new PrinterPins<ReturnType<MCUGroup['session']>>();
 for(const [id,mcu] of mcus){pins.register(id,mcu.chip);if(!clocks.has(id))throw new Error(`Missing hardware clock: ${id}`);}
 // Fresh timelines belong to this assembly; failed plans cannot mutate callers.
 const sharedClocks=new Map([...mcus.keys()].map(id=>{const mapping=clocks.get(id)!,sync=mapping.synchronizer;
  if(sync){const c=sync.mapping;if(!(sync instanceof SecondarySync)||c.offset!==mapping.calibration.offset||c.frequency!==mapping.calibration.frequency||!devices.some(d=>d.id!==id&&sync.usesClocks(group.session(d.id).clock.sync,group.session(id).clock.sync)))throw new Error('Secondary synchronizer differs from physical hardware clock');}
  return [id,{currentPrintTime:mapping.currentPrintTime,calibration:{...mapping.calibration},timeline:new PrintClockTimeline(mapping.calibration),synchronizer:sync?.fork()}] as const;}));
 applyConfiguredBoardPins(reader,pins);
 const boards=layout.boards??[];if(new Set(boards.map(b=>b.mcu)).size!==boards.length)throw new Error('Duplicate hardware board mapping');
 for(const board of boards){const resolver=pins.resolver(board.mcu);for(const [name,pin] of Object.entries(board.aliases??{}))resolver.alias(name,pin);for(const pin of board.reserved??[])resolver.reserve(pin,'machine');}
 if(new Set(layout.steppers.map(s=>s.emitter)).size!==layout.steppers.length)throw new Error('Duplicate hardware emitter');
 // Strip external OID overrides: one deterministic allocator owns this plan.
 const steppers=layout.steppers.length?compileConfiguredSteppers(reader,pins,mcus,layout.steppers.map(s=>({section:s.section,unitsInRadians:s.unitsInRadians,requestBothEdges:s.requestBothEdges}))):Object.freeze([]);
 const motors=steppers.length?compileConfiguredMotorEnables(reader,pins,group,steppers.map((s,i)=>({section:s.section,emitter:layout.steppers[i].emitter,mcu:s.mcu,leadTime:layout.steppers[i].enableLeadTime,calibration:sharedClocks.get(s.mcu)!.calibration,timeline:sharedClocks.get(s.mcu)!.timeline}))):Object.freeze({lines:Object.freeze([]),alwaysOn:Object.freeze([])});
 const homing=layout.homing.length?compileConfiguredHoming(reader,pins,mcus,layout.homing.map(h=>({section:h.section,triggers:h.mcus.map(mcu=>({mcu}))}))):Object.freeze([]);
 const bltouch=compileConfiguredBLTouch(reader,pins,mcus,sharedClocks,homing);
 const fans=layout.fans.length?compileConfiguredCoolingFans(reader,pins,mcus,sharedClocks,layout.fans.map(f=>({section:f.section,minimumScheduleTime:f.minimumScheduleTime,capacity:f.capacity}))):Object.freeze([]);
 if(layout.heaters.length>64||new Set(layout.heaters.map(h=>h.section)).size!==layout.heaters.length)throw new Error('Invalid heater batch');
 const spiHeaterSections=layout.heaters.filter(h=>['MAX6675','MAX31855','MAX31856'].includes(reader.section(h.section).get('sensor_type'))),analogHeaterSections=layout.heaters.filter(h=>!spiHeaterSections.includes(h));
 const heaters=analogHeaterSections.length?compileConfiguredAnalogHeaters(reader,pins,mcus,sharedClocks,analogHeaterSections.map(h=>({section:h.section}))):Object.freeze([]);
 if((layout.sensors?.length??0)>128||new Set(layout.sensors?.map(s=>s.section)).size!==(layout.sensors?.length??0))throw new Error('Invalid temperature sensor batch');
 const hostSections=(layout.sensors??[]).filter(s=>reader.section(s.section).get('sensor_type')==='temperature_host');
 if(new Set(hostSections.map(s=>s.section.trim().split(/\s+/).at(-1))).size!==hostSections.length)throw new Error('Duplicate host temperature object name');
 const hostSensors=Object.freeze(hostSections.map(s=>readHostTemperature(reader,s.section)));
 const spiSections=(layout.sensors??[]).filter(s=>['MAX6675','MAX31855','MAX31856'].includes(reader.section(s.section).get('sensor_type')));
 const spiInputs=compileConfiguredSpiSensors(reader,pins,mcus,sharedClocks,[...spiSections,...spiHeaterSections]);
 const spiSensors=Object.freeze(spiInputs.filter(p=>spiSections.some(s=>s.section===p.section))),spiHeaters=compileConfiguredSpiHeaters(reader,pins,mcus,sharedClocks,spiInputs.filter(p=>spiHeaterSections.some(h=>h.section===p.section)));
 const allHeaters=Object.freeze(layout.heaters.map(h=>[...heaters,...spiHeaters].find(p=>p.section===h.section)!));
 const sensors=compileConfiguredAnalogSensors(reader,pins,mcus,sharedClocks,(layout.sensors??[]).filter(s=>!hostSections.includes(s)&&!spiSections.includes(s)));
 const buttons=layout.buttons?.length?compileConfiguredButtons(reader,pins,mcus,sharedClocks,layout.buttons):Object.freeze([]);
 const tmcSections=reader.sections().filter(s=>/^tmc\d+ /.test(s));if(tmcSections.length>128||new Set(tmcSections.map(s=>s.slice(s.indexOf(' ')+1))).size!==tmcSections.length)throw new Error('Duplicate or excessive TMC stepper owners');
 const tmcSpis=compileConfiguredTmcSpi(reader,pins,mcus,steppers);
 const tmcUarts=compileConfiguredTmcUart(reader,pins,mcus,steppers);
 const pending=new Map(devices.map(({id})=>[id,{commands:[] as string[],restart:[] as string[],init:[] as string[],reservedMoves:0}]));
 const add=(mcu:string,part:{commands:readonly string[];restart?:readonly string[];init?:readonly string[];reservedMoves?:number})=>{const p=pending.get(mcu)!;p.commands.push(...part.commands);p.restart.push(...part.restart??[]);p.init.push(...part.init??[]);p.reservedMoves+=part.reservedMoves??0;};
 for(const s of steppers)add(s.mcu,{commands:[s.config],restart:[s.restart]});
 for(const m of motors.lines)add(m.mcu,{commands:[m.config.config],restart:[m.config.restart],reservedMoves:m.config.reservedMoves});
 for(const h of homing){add(h.mcu,h.endstop);for(const t of h.triggers)add(t.mcu,t.protocol);}
 if(bltouch){add(bltouch.output.mcu,bltouch.output.pwm);add(bltouch.verification.mcu,bltouch.verification.protocol);}
 for(const f of fans){add(f.output.mcu,f.output.pwm);if(f.enable)add(f.enable.mcu,f.enable.pwm);}
 for(const h of heaters){add(h.output.mcu,h.output.pwm);add(h.sensor.mcu,h.sensor.adc);}
 for(const h of spiHeaters)add(h.output.mcu,h.output.pwm);
 for(const s of sensors)add(s.mcu,s.adc);
 for(const b of buttons)add(b.mcu,b.buttons);
 for(const b of tmcSpis)add(b.mcu,{commands:[b.spi.select]});
 for(const s of spiInputs)add(s.mcu,{commands:[s.spi.select]});
 for(const b of tmcSpis)add(b.mcu,{commands:[b.spi.configureBus]});
 for(const s of spiInputs){add(s.mcu,{commands:[s.spi.configureBus,...s.commands],init:s.init});}
 for(const b of tmcUarts)add(b.mcu,b.uart);
 const configurations=Object.freeze(devices.map(({id},physicalMember)=>{
  const resources=mcuOids(pins).finalize(id),p=pending.get(id)!;
  const plan:Readonly<MCUConfigPlan>=Object.freeze({oidCount:resources.oidCount,commands:Object.freeze(p.commands),restart:Object.freeze(p.restart),init:Object.freeze(p.init),reservedMoves:p.reservedMoves});
  return Object.freeze({mcu:id,physicalMember,clock:readPrintClock(sharedClocks.get(id)!.calibration,sharedClocks.get(id)!.timeline),timeline:sharedClocks.get(id)!.timeline,synchronizer:sharedClocks.get(id)!.synchronizer,session:mcus.get(id)!.chip,resources,plan});
 }));
 return Object.freeze({configurations,steppers:Object.freeze(steppers.map((s,i)=>Object.freeze({...s,emitter:layout.steppers[i].emitter,physicalMember:devices.findIndex(d=>d.id===s.mcu)}))),motors,homing,bltouch,fans,heaters,spiHeaters,allHeaters,sensors,spiSensors,hostSensors,buttons,tmcUarts,tmcSpis});
}
