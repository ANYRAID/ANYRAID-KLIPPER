import type {MotionProfileOptions} from '../src/diagnostics/graph-motion.ts';
import type {MotionFilter} from '../src/diagnostics/motion-filters.ts';
export interface MotionReferenceCase {filter?:MotionFilter;smoothTime?:number;profile?:MotionProfileOptions;}
/** Explicit original diagnostic cases; defaults normalized for identical requests. */
export function motionReferenceKey({filter,smoothTime=(2/3)/40,profile={}}:MotionReferenceCase):string{return JSON.stringify({filter:filter??null,smoothTime,order:profile.order??2,jerkLimit:profile.jerkLimit??false,legacyShaper:profile.legacyShaper??'ei'});}
const cases:MotionReferenceCase[]=[{}];
for(const filter of ['average','smooth','weighted','weighted2','weighted3','weighted4','spring_raw','spring_double_weighted'] as const)cases.push({filter});
for(const order of [2,4,6] as const)for(const jerkLimit of [false,true])for(const filter of [undefined,'weighted4'] as const)cases.push({filter,profile:{order,jerkLimit}});
for(const legacyShaper of ['zv','zvd','mzv','ei','2hump_ei','3hump_ei'] as const)for(const jerkLimit of [false,true])cases.push({profile:{legacyShaper,jerkLimit,order:jerkLimit?6:2}});
cases.push({filter:'weighted4',smoothTime:.020});
export const motionReferenceCases=Array.from(new Map(cases.map(c=>[motionReferenceKey(c),c])).values());
