import type {NativeLinearHomingPort,PausedMove} from '../homing/native-linear-port.ts';
export interface PauseParkingConfig {
 parkXY:readonly [number,number];retract:number;lift:number;
 travelSpeed:number;liftSpeed:number;retractSpeed:number;
}
type ParkingPort=Pick<NativeLinearHomingPort,'pause'|'validatePausedPath'|'movePaused'|'resumeStream'|'motorOff'>;
/** Configured product operation, without submitting macros or changing print
 * modal coordinates. The machine configuration owns collision-free parking
 * coordinates and lift distance; all legs still pass live motion guards. */
export class NativePauseParking {
 #extrusionAxis:(()=>number)|undefined;#parkedAxis:number|undefined;
 #beforeStreamResume:(()=>void)|undefined;
 #port:ParkingPort;#config:PauseParkingConfig;#phase:'idle'|'pausing'|'parked'|'resuming'|'failed'='idle';
 #pause:Promise<void>|undefined;#return:PausedMove[]=[];
 constructor(port:ParkingPort,config:PauseParkingConfig,beforeStreamResume?:()=>void,extrusionAxis?:()=>number){
  if(extrusionAxis!==undefined&&typeof extrusionAxis!=='function')throw new TypeError('Invalid parking extrusion selector');this.#extrusionAxis=extrusionAxis;
  if(beforeStreamResume!==undefined&&typeof beforeStreamResume!=='function')throw new TypeError('Invalid stream resume observer');this.#beforeStreamResume=beforeStreamResume;
  if(!Array.isArray(config.parkXY)||config.parkXY.length!==2||!config.parkXY.every(Number.isFinite)||![config.retract,config.lift].every(v=>Number.isFinite(v)&&v>=0)||![config.travelSpeed,config.liftSpeed,config.retractSpeed].every(v=>Number.isFinite(v)&&v>0))throw new RangeError('Invalid pause parking configuration');
  this.#port=port;this.#config={...config,parkXY:[config.parkXY[0],config.parkXY[1]]};
 }
 get status(){return {phase:this.#phase};}
 async #fail(error:unknown):Promise<never>{this.#phase='failed';try{await this.#port.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Pause parking and stop failed');}throw error;}
 pause(signal:AbortSignal):Promise<void>{
  try{signal.throwIfAborted();if(this.#phase==='pausing'||this.#phase==='parked')return this.#pause!;if(this.#phase!=='idle')throw new Error('Parking operation is not idle');}catch(error){return Promise.reject(error);}
  this.#phase='pausing';const done=Promise.withResolvers<void>();this.#pause=done.promise;
  void (async()=>{
   try{
    const stopped=await this.#port.pause(signal);signal.throwIfAborted();const p=[...stopped.position],c=this.#config;
    const axis=this.#extrusionAxis?.()??3;if(!Number.isInteger(axis)||axis<3||axis>=p.length||p.length!==4&&!this.#extrusionAxis)throw new Error('Parking requires the active extrusion axis');this.#parkedAxis=axis;
    const retracted=[...p];retracted[axis]-=c.retract;const lifted=[...retracted];lifted[2]+=c.lift;const parked=[...lifted];parked[0]=c.parkXY[0];parked[1]=c.parkXY[1];
    const outward:PausedMove[]=[{position:retracted,speed:c.retractSpeed},{position:lifted,speed:c.liftSpeed},{position:parked,speed:c.travelSpeed}];
    this.#return=[{position:lifted,speed:c.travelSpeed},{position:retracted,speed:c.liftSpeed},{position:p,speed:c.retractSpeed}];
    // Validate the full round trip before the first parking pulse. Each actual
    // leg validates again, so cooling or revoked homing cannot use stale approval.
    this.#port.validatePausedPath([...outward,...this.#return]);
    for(const leg of outward)await this.#port.movePaused(leg.position,leg.speed,signal);
    signal.throwIfAborted();this.#phase='parked';
   }catch(error){await this.#fail(error);}
  })().then(done.resolve,done.reject);return done.promise;
 }
 async resume(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(this.#phase!=='parked')throw new Error('Parking operation is not parked');this.#phase='resuming';
  try{
   if((this.#extrusionAxis?.()??3)!==this.#parkedAxis)throw new Error('Active tool changed while parked');
   this.#port.validatePausedPath(this.#return);
   for(const leg of this.#return)await this.#port.movePaused(leg.position,leg.speed,signal);
   signal.throwIfAborted();this.#beforeStreamResume?.();
   await this.#port.resumeStream(signal);signal.throwIfAborted();this.#return=[];this.#pause=undefined;this.#phase='idle';
  }catch(error){await this.#fail(error);}
 }
}
