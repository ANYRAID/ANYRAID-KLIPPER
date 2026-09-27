/** Model-specific current implementation exposed through one motion-owned port. */
export interface TmcCurrentControl {
 readonly maxCurrent:number;
 readonly revision:number;
 readonly current:Readonly<{runCurrent:number;holdCurrent:number;irun:number;ihold:number}>;
 set(change:{run?:number;hold?:number},signal:AbortSignal):Promise<void>;
}
