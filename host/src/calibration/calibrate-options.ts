// GPL-3.0-or-later. Strict CLI decoding for the bounded shaper fitting core.
import type {FitOptions} from './shaper-fit.ts';
import {parseShaperName} from '../motion/shaper.ts';
export function calibrationOptions(values:Record<string,string|boolean|undefined>):FitOptions{
 const number=(s:string)=>{if(!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(s)||!Number.isFinite(Number(s)))throw new RangeError('Expected a finite nonnegative decimal');return Number(s);};
 const options:FitOptions={};for(const [key,target] of [['damping_ratio','damping'],['scv','squareCornerVelocity'],['max_smoothing','maxSmoothing'],['max_freq','maxFrequency']] as const){if(values[key]!==undefined)options[target]=number(String(values[key]));}
 if(options.maxSmoothing!==undefined&&options.maxSmoothing<.05)throw new RangeError('max_smoothing must be at least 0.05');
 if(values.max_vibrs_pcnt!==undefined){const percent=number(String(values.max_vibrs_pcnt));if(percent<.1)throw new RangeError('max_vibrs_pcnt must be at least 0.1');options.maxVibrations=percent*.01;}
 if(values.test_damping_ratios!==undefined)options.testDamping=String(values.test_damping_ratios).split(',').map(number);
 if(values.shapers!==undefined){options.shapers=String(values.shapers).toLowerCase().split(/,(?![^(]*\))/);for(const name of options.shapers)parseShaperName(name);}
 if(values.shaper_freq!==undefined){const text=String(values.shaper_freq);let end:number;if(text.includes(':')){const parts=text.split(':');if(parts.length<2||parts.length>3||!parts[1])throw new RangeError('Expected [start]:end[:step]');const start=parts[0]?number(parts[0]):undefined;end=number(parts[1]);const step=parts[2]?number(parts[2]):undefined;if(end<=0||start!==undefined&&(start<=0||start>end)||step!==undefined&&step<=0)throw new RangeError('Invalid shaper frequency range');options.range={start,end,step};}else{options.frequencies=text.split(',').map(number);if(!options.frequencies.length||options.frequencies.some((f,i)=>f<=0||i>0&&f<=options.frequencies![i-1]))throw new RangeError('Shaper frequencies must be positive and increasing');end=options.frequencies.at(-1)!;}if(options.maxFrequency!==undefined)options.maxFrequency=Math.max(options.maxFrequency,end*4/3);}
 return options;
}
