import type {ShaperSimulationOptions} from '../src/diagnostics/graph-shaper.ts';
/** Cases captured from the original diagnostic before its Python entry retired. */
export const shaperGraphCases:ShaperSimulationOptions[]=['zv','mzv','zvd','ei','2hump_ei','3hump_ei','mzv(n=5,t=.75)'].map(shaper=>({shaper}));
shaperGraphCases.push(
 {shaper:'ZVD',frequency:30,damping:0,testDamping:[0,.2,.9],systemFrequency:17,systemDamping:0},
 {shaper:'ei',frequency:75,damping:.3,testDamping:[.05],systemFrequency:100,systemDamping:.8},
 {shaper:'mzv(n=3,t=0.6666666666)'},{shaper:'mzv(n=3,t=.8)'},
 {shaper:'mzv(n=5,t=1.1)'},{shaper:'mzv(n=6,t=1.0)'},
 {shaper:'mzv',testDamping:Array.from({length:16},(_,i)=>i*.05)},
 {shaper:'zv',frequency:.01,systemFrequency:.01,damping:0,testDamping:[0]},
);
