import {setTimeout as delay} from 'node:timers/promises';
import type {compileConfiguredHardware} from '../config/hardware.ts';
import {MCUGroup} from './mcu-group.ts';
import {GenerationPWMOutput} from '../outputs/generation-pwm.ts';
import {BLTouchDevice} from '../homing/bltouch-device.ts';
import {EndstopVerification} from '../homing/endstop-verification.ts';
import {serialClock} from '../protocol/serial-queue.ts';
const owners=new WeakSet<object>();
/** Bind only after all MCU configurations succeed. Probe callers must drain
 * ordinary motion before opening a device session, and rebase after its waits. */
export function attachConfiguredBLTouch(group:MCUGroup,hardware:ReturnType<typeof compileConfiguredHardware>){
 const plan=hardware.bltouch;if(!plan)throw new Error('No compiled BLTouch');
 group.assertActive();if(owners.has(plan))throw new Error('BLTouch resources already owned');
 const outputSession=group.session(plan.output.mcu),sensorSession=group.session(plan.sensor.mcu),mapping=hardware.configurations.find(c=>c.mcu===plan.sensor.mcu);
 if(!mapping||mapping.session!==sensorSession||plan.output.pin.chip!==outputSession||plan.sensor.pin.chip!==sensorSession||plan.verification.mcu!==plan.sensor.mcu||!outputSession.status.configured||!sensorSession.status.configured)throw new Error('BLTouch hardware is not configured');
 const p=plan.output,output=p.timeline?GenerationPWMOutput.withClock(p.pwm,outputSession.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.timeline):new GenerationPWMOutput(p.pwm,outputSession.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.clock.clockAt,p.clock.printTimeAtClock);
 const domains=[{session:outputSession,clock:p.clock},{session:sensorSession,clock:mapping.clock}];
 const now=()=>{group.assertActive();const wall=serialClock.now();return Math.max(...domains.map(d=>d.clock.printTimeAtClock(d.session.clock.sync.getClock(wall))));};
 const waitUntil=async(time:number,signal:AbortSignal)=>{if(!Number.isFinite(time)||time<0)throw new RangeError('Invalid BLTouch wait time');for(;;){signal.throwIfAborted();group.assertActive();const wall=serialClock.now();if(domains.every(d=>d.session.clock.sync.getClock(wall)>=d.clock.clockAt(time)))return;await delay(2,undefined,{signal});}};
 const verifier=new EndstopVerification(sensorSession,sensorSession.commandQueue(),plan.sensor.endstop,plan.verification.protocol,mapping.clock.clockAt,waitUntil);
 let stopping:Promise<void>|undefined,detach=()=>{};
 const stop=(cause:unknown)=>{if(stopping)return stopping;const done=Promise.withResolvers<void>();stopping=done.promise;detach();void Promise.allSettled([group.stop(cause),output.stop(cause)]).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'BLTouch hardware stop failed'));else done.resolve();});return stopping;};
 const device=new BLTouchDevice({clockAt:p.clock.clockAt,printAt:p.clock.printTimeAtClock,secondsToClock:t=>BigInt(Math.trunc(t*Number(outputSession.dictionary.constant('CLOCK_FREQ')))),estimatedPrintTime:now,motionPrintTime:now,waitUntil,setPWM:(...args)=>output.setPWM(...args),verifyState:(...args)=>verifier.verify(...args),stop},plan.settings);
 let started=false;owners.add(plan);detach=group.subscribeStop(cause=>{void device.stop(cause).catch(()=>{});});
 return Object.freeze({device,endstop:plan.sensor.endstop,async start(signal:AbortSignal){if(started)throw new Error('BLTouch hardware already started');started=true;try{await output.reset(signal);await device.initialize(signal);}catch(error){try{await device.stop(error);}catch(cleanup){throw new AggregateError([error,cleanup],'BLTouch startup and stop failed');}throw error;}},close:(cause:unknown)=>device.stop(cause),get status(){return {device:device.status,output:output.status,verification:verifier.status};}});
}
