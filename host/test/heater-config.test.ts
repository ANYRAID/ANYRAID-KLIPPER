import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {createConfiguredHeater} from '../src/thermal/heater-config.ts';
const reader=(values:Record<string,string>,extra:Record<string,Record<string,string>>={},name='extruder')=>new ConfigurationReader(new ConfigurationSource('/heater.cfg',{[name]:{sensor_type:'Generic 3950',min_temp:'0',max_temp:'300',control:'pid',pid_kp:'22',pid_ki:'1',pid_kd:'80',...values},...extra},[]),null);
function fixture(){const calls:{method:string;value:number}[]=[];let now=1;const output={configureCycleTime(v:number){calls.push({method:'cycle',value:v});},configureMaximumDuration(v:number){calls.push({method:'watchdog',value:v});},schedule(_t:number,v:number){calls.push({method:'power',value:v});},turnOff(){calls.push({method:'off',value:0});}};return {calls,output,clock:()=>({system:now,print:now}),advance(v:number){now=v;}};}
test('configured heater validates before effects then uses ADC, PID and watchdog runtime',()=>{
 const f=fixture(),heater=createConfiguredHeater(reader({}), 'extruder',f.output,f.clock,()=>()=>{});
 assert.equal(f.calls.length,0);heater.runtime.start();assert.deepEqual(f.calls.slice(0,2),[{method:'cycle',value:.1},{method:'watchdog',value:3}]);
 assert.throws(()=>heater.runtime.setTarget(200),/Fresh/);
 heater.adc.receive([[1,heater.converter.adc(25)]]);heater.runtime.setTarget(200);
 f.advance(1.3);heater.adc.receive([[1.3,heater.converter.adc(26)]]);
 assert.ok(f.calls.some(c=>c.method==='power'&&c.value>0));
 assert.throws(()=>heater.adc.receive([[1.6,1]]));assert.equal(heater.runtime.status.stopped,true);assert.equal(f.calls.at(-1)?.method,'off');
});
test('bed watermark defaults preserve unreachable extrusion threshold without enabling extrusion',()=>{
 const f=fixture(),heater=createConfiguredHeater(reader({max_temp:'130',control:'watermark'},{},'heater_bed'),'heater_bed',f.output,f.clock,()=>()=>{});
 assert.equal(heater.settings.minimumExtrude,170);assert.equal(heater.verification.checkGainTime,60);
 heater.runtime.start();heater.adc.receive([[1,heater.converter.adc(100)]]);assert.equal(heater.runtime.canExtrude(),false);heater.runtime.shutdown('test');
});
test('invalid control, PWM timing, calibration limits and PID reject before output access',()=>{
 const cases:Record<string,string>[]=[{control:'unknown'},{pwm_cycle_time:'.4'},{max_temp:'0'},{pid_ki:'-1'},{max_power:'2'},{min_extrude_temp:'301'}];
 for(const options of cases){
  const f=fixture();assert.throws(()=>createConfiguredHeater(reader(options),'extruder',f.output,f.clock,()=>()=>{}));assert.equal(f.calls.length,0);
 }
});
test('verification overrides and failed cycle configuration retain shutdown protection',()=>{
 const f=fixture(),heater=createConfiguredHeater(reader({}, {'verify_heater extruder':{check_gain_time:'40',max_error:'70'}}),'extruder',{...f.output,configureCycleTime(){throw new Error('cycle failed');}},f.clock,()=>()=>{});
 assert.equal(heater.verification.checkGainTime,40);assert.equal(heater.verification.maxError,70);
 assert.throws(()=>heater.runtime.start(),/cycle failed/);assert.equal(f.calls.at(-1)?.method,'off');
});
test('configured async heater requires safe output metadata and ACK before activation',async()=>{
 const {createConfiguredAsyncHeater}=await import('../src/thermal/heater-config.ts');
 const requests:unknown[]=[],reset=Promise.withResolvers<void>(),stop=Promise.withResolvers<void>();let resets=0,stops=0;
 const heater=createConfiguredAsyncHeater(reader({pwm_cycle_time:'.2'}),'extruder',requirements=>{
  requests.push(requirements);assert.equal(Object.isFrozen(requirements),true);
  return {configuration:{cycleTime:.2,maximumDuration:3,defaultPower:0,initialPower:0},reset(){resets++;return reset.promise;},setPWM:async()=>{},stop(){stops++;return stop.promise;}};
 },()=>({system:1,print:1}),()=>()=>{});
 assert.deepEqual(requests,[{cycleTime:.2,maximumDuration:3,start:0,shutdown:0}]);assert.equal(resets,0);assert.equal(stops,0);
 const starting=heater.runtime.start();assert.equal(heater.runtime.status.phase,'starting');reset.resolve();await starting;
 heater.adc.receive([[1,heater.converter.adc(25)]]);await heater.runtime.setTarget(200);
 assert.throws(()=>heater.adc.receive([[1.3,1]]),/range/);assert.equal(heater.runtime.status.phase,'stopping');assert.equal(stops,1);
 stop.resolve();await heater.runtime.shutdown();assert.equal(heater.runtime.status.phase,'stopped');
});
test('async configuration rejects invalid settings before output factory and unsafe output before reset',async()=>{
 const {createConfiguredAsyncHeater}=await import('../src/thermal/heater-config.ts');let constructed=0,resets=0;
 const factory=()=>{constructed++;return {configuration:{cycleTime:.1,maximumDuration:3,defaultPower:0,initialPower:0},reset:async()=>{resets++;},setPWM:async()=>{},stop:async()=>{}};};
 for(const values of [{control:'unknown'},{pwm_cycle_time:'.31'},{max_power:'2'},{sensor_type:'missing'},{sensor_type:'AD595',min_temp:'-100'}] as Record<string,string>[])assert.throws(()=>createConfiguredAsyncHeater(reader(values),'extruder',factory,()=>({system:1,print:1})));
 assert.equal(constructed,0);
 for(const override of [{cycleTime:.2},{initialPower:1},{defaultPower:1},{maximumDuration:2}])assert.throws(()=>createConfiguredAsyncHeater(reader({}),'extruder',()=>{const output=factory();Object.assign(output.configuration,override);return output;},()=>({system:1,print:1})),/match|requires/);
 assert.equal(resets,0);
});
test('async and synchronous configuration preserve bed and PID defaults identically',async()=>{
 const {createConfiguredAsyncHeater}=await import('../src/thermal/heater-config.ts');
 for(const name of ['extruder','heater_bed']){
  const options=name==='heater_bed'?{control:'watermark',max_temp:'130'}:{control:'pid',max_temp:'300'},f=fixture(),source=reader(options,{},name);
  const sync=createConfiguredHeater(source,name,f.output,f.clock,()=>()=>{});
  const async=createConfiguredAsyncHeater(source,name,r=>({configuration:{cycleTime:r.cycleTime,maximumDuration:r.maximumDuration,defaultPower:r.shutdown,initialPower:r.start},reset:async()=>{},setPWM:async()=>{},stop:async()=>{}}),f.clock,()=>()=>{});
  assert.deepEqual(async.settings,sync.settings);assert.deepEqual(async.verification,sync.verification);assert.equal(async.pwmCycleTime,sync.pwmCycleTime);
  await async.runtime.start();async.adc.receive([[1,async.converter.adc(100)]]);assert.equal(async.runtime.canExtrude(),false);await async.runtime.shutdown();
 }
});
