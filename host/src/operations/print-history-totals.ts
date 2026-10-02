import {JournalError,type PrintStatistics} from './print-journal-types.ts';
interface Sum {value:number;correction:number;unknown:number;overflow:boolean;maximum:number;}
export interface HistoryTotalsState {jobs:number;time:Sum;print:Sum;filament:Sum;}
const empty=():Sum=>({value:0,correction:0,unknown:0,overflow:false,maximum:0});
export const emptyHistoryTotals=():HistoryTotalsState=>({jobs:0,time:empty(),print:empty(),filament:empty()});
export function decodeHistoryTotals(json:string):HistoryTotalsState {
 try{
  const state=JSON.parse(json) as HistoryTotalsState;
  if(!state||Object.keys(state).sort().join(',')!=='filament,jobs,print,time'||!Number.isSafeInteger(state.jobs)||state.jobs<0)throw Error();
  for(const sum of [state.time,state.print,state.filament]){
   if(!sum||Object.keys(sum).sort().join(',')!=='correction,maximum,overflow,unknown,value'||![sum.value,sum.correction,sum.maximum].every(v=>typeof v==='number'&&Number.isFinite(v))||!Number.isSafeInteger(sum.unknown)||sum.unknown<0||sum.unknown>state.jobs||typeof sum.overflow!=='boolean')throw Error();
  }
  if(state.time.value<0||state.print.value<0||[state.time,state.print,state.filament].some(sum=>sum.maximum<0))throw Error();
  return state;
 }catch{throw new JournalError('CORRUPT','Invalid persisted history totals');}
}
function add(sum:Sum,value:number|null|undefined):void{
 if(value==null){sum.unknown++;return;}
 sum.maximum=Math.max(sum.maximum,value);
 if(sum.overflow)return;
 const adjusted=value-sum.correction,total=sum.value+adjusted,correction=(total-sum.value)-adjusted;
 if(!Number.isFinite(total)||!Number.isFinite(correction)){sum.overflow=true;sum.value=0;sum.correction=0;return;}
 sum.value=total;sum.correction=correction;
}
export function addHistoryTotals(state:HistoryTotalsState,statistics?:PrintStatistics):void{
 if(state.jobs===Number.MAX_SAFE_INTEGER)throw new JournalError('CAPACITY','History job count exhausted');state.jobs++;
 add(state.time,statistics?.totalDuration);add(state.print,statistics?.printDuration);add(state.filament,statistics?.filamentUsed);
}
export function historyTotalsView(state:HistoryTotalsState){
 const value=(sum:Sum)=>sum.unknown||sum.overflow?null:sum.value;
 return {job_totals:{total_jobs:state.jobs,total_time:value(state.time),total_print_time:value(state.print),total_filament_used:value(state.filament),longest_job:state.time.unknown?null:state.time.maximum,longest_print:state.print.unknown?null:state.print.maximum},auxiliary_totals:[],native_unknown:{total_duration:state.time.unknown,print_duration:state.print.unknown,filament_used:state.filament.unknown},native_overflow:[...state.time.overflow?['total_time']:[],...state.print.overflow?['total_print_time']:[],...state.filament.overflow?['total_filament_used']:[]]};
}
export type NativeHistoryTotals=ReturnType<typeof historyTotalsView>;
export type NativeHistoryReset={last_totals:NativeHistoryTotals['job_totals'];last_auxiliary_totals:never[];last_native_unknown:NativeHistoryTotals['native_unknown'];last_native_overflow:string[]};
