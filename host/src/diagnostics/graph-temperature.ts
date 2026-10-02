// Temperature sensor diagnostics, GPL-3.0-or-later.
// Based on scripts/graph_temp_sensor.py, Kevin O'Connor (2020).
import {createLinearSensor,linearSensorNames} from '../thermal/linear-sensors.ts';
import {Thermistor} from '../thermal/thermistor.ts';
import {thermistorDefaults} from '../thermal/thermistor-defaults.ts';
import type {StatsPanel} from './stats-svg.ts';
export const temperatureGraphSensors:readonly string[]=Object.freeze([...linearSensorNames,...Object.keys(thermistorDefaults)].sort());
export function temperaturePlots(options:{sensors?:readonly string[];pullup?:number;voltage?:number;resistance?:boolean}={}):StatsPanel[]{
 const names=options.sensors??temperatureGraphSensors,pullup=options.pullup??4700,voltage=options.voltage??5;
 if(!Number.isFinite(pullup)||pullup<=0||!Number.isFinite(voltage)||voltage<=0)throw new RangeError('Expected positive finite pullup and voltage');
 if(!names.length||names.length>32||names.some(n=>!temperatureGraphSensors.includes(n)))throw new RangeError('Expected 1 to 32 known sensor names');
 const xAxis={label:'Temperature (C)',format:'number' as const},panels:StatsPanel[]=options.resistance?[{xAxis,plot:{title:`Temperature sensor resistance (pullup=${pullup})`,axes:['Resistance (Ohms)'],curves:[]}}]:[{xAxis,plot:{title:`Temperature sensors (pullup=${pullup}, voltage=${voltage})`,axes:['ADC'],curves:[]}},{xAxis,plot:{title:'ADC resolution',axes:['ADC change per 1C'],curves:[]}}];
 for(const name of names){const sensor=Object.hasOwn(thermistorDefaults,name)?new Thermistor(pullup,0,thermistorDefaults[name]):createLinearSensor(name,{voltage,pullup}),adcs=Array.from({length:350},(_,i)=>sensor.adc(i+1));
  const values=options.resistance?adcs.map(adc=>pullup*adc/(1-adc)):adcs.slice(0,-1);if(values.some(v=>!Number.isFinite(v)))throw new RangeError('Nonfinite diagnostic resistance');
  panels[0].plot.curves.push({label:name,axis:0,style:'line',times:values.map((_,i)=>i+1),values});
  if(!options.resistance)panels[1].plot.curves.push({label:name,axis:0,style:'line',times:values.map((_,i)=>i+1),values:values.map((v,i)=>Math.abs(adcs[i+1]-v))});
 }return panels;
}
