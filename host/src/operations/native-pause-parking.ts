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
 #port:ParkingPort;#config:PauseParkingConfig;#phase:'idle'|'pausing'|'parked'|'resuming'|'failed'='idle';
 #pause:Promise<void>|undefined;#return:PausedMove[]=[];
 constructor(port:ParkingPort,config:PauseParkingConfig){
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
    const retracted=[p[0],p[1],p[2],p[3]-c.retract],lifted=[p[0],p[1],p[2]+c.lift,retracted[3]],parked=[...c.parkXY,lifted[2],retracted[3]];
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
   this.#port.validatePausedPath(this.#return);
   for(const leg of this.#return)await this.#port.movePaused(leg.position,leg.speed,signal);
   await this.#port.resumeStream(signal);signal.throwIfAborted();this.#return=[];this.#pause=undefined;this.#phase='idle';
  }catch(error){await this.#fail(error);}
 }
}
