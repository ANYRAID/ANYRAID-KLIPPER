import assert from 'node:assert/strict';
import {registerNativeTemperatureFans} from '../src/moonraker/native-temperature-fan.ts';
import {TemperatureFanControl} from '../src/thermal/temperature-fan.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
const samples:number[]=[];
for(let run=0;run<12;run++){
 const name='temperature_fan chamber',path='/printer/settings/temperature_fan',control=new TemperatureFanControl({minimumTemperature:0,maximumTemperature:100,target:40,minimumSpeed:.3,maximumSpeed:1},{kind:'watermark',delta:2},.3);
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),close=registerNativeTemperatureFans(registry,[{section:name,control}],()=>true),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize:()=>{}};
 let receipt=await registry.invoke(path,'GET',{name},context) as any;const start=performance.now();
 for(let i=0;i<10000;i++)receipt=await registry.invoke(path,'POST',{name,version:1,state_token:receipt.state_token,target:40+i%2},context);
 const elapsed=performance.now()-start;assert.equal(control.settings.target,41);close();if(run>=3)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,updates:10000,warmups:3,runs:9,medianMs:samples[4],maxMs:samples[8],scope:'Authorized registry dispatch, state tokens, validation and settings receipts; excludes HTTP transport and sensor/PWM IO'},null,2));
