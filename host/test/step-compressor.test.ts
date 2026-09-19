import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
function rows(count:number,start=.001,direction=1){return Float64Array.from({length:count*3},(_,i)=>i%3===0?direction:i%3===1?start+Math.floor(i/3)*.001:0);}
test('native compression retains exact clocks, direction, position and history',()=>{
 using c=new StepCompressor(settings);c.append(rows(100));const result=c.flush();
 assert.equal(result.position,100n);assert(result.messages.length>0);assert.equal(result.history[0],1000n);assert.equal(result.history[1],100000n);
 assert.equal(result.history[3],100n);assert.equal(result.history[4],1000n);assert.equal(result.history[5],0n);
 c.append(rows(50,.101,0));assert.equal(c.flush().position,50n);assert.equal(c.flush().messages.length,0);
});
test('rapid step direction step filter and explicit flush boundary match native semantics',()=>{
 using c=new StepCompressor(settings);c.append(new Float64Array([1,.001,0,0,.0011,0]));assert.equal(c.flush().position,0n);
 c.append(new Float64Array([1,.002,0]));assert.equal(c.flush().position,1n);
 c.append(new Float64Array([0,.0021,0]));assert.equal(c.flush().position,0n);
});
test('batch errors are atomic; handles and shared buffers cannot corrupt native state',()=>{
 using c=new StepCompressor(settings);assert.throws(()=>c.append(new Float64Array([1,.001,0,2,.002,0])));
 assert.throws(()=>c.append(new Float64Array(new SharedArrayBuffer(24))));assert.equal(c.flush().position,0n);
 c.append(rows(2));assert.throws(()=>c.append(rows(1,.001)));assert.equal(c.flush().position,2n);
 c.dispose();assert.throws(()=>c.flush());assert.throws(()=>c.append(rows(1)));c.dispose();
 assert.throws(()=>new StepCompressor({...settings,initialClock:1n<<54n}));
 assert.throws(()=>new StepCompressor({...settings,frequency:0}));
});
test('64-bit clock output survives the MCU 32-bit wrap',()=>{
 const initialClock=(1n<<32n)-1000n;
 using c=new StepCompressor({...settings,initialClock});c.append(rows(3,Number(initialClock)/1e6+.001));
 const result=c.flush();assert.equal(result.history[0],1n<<32n);assert.equal(result.history[1],(1n<<32n)+2000n);
});
test('one-tick spacing and bounded pending steps',()=>{
 using c=new StepCompressor(settings);c.append(new Float64Array([1,.001,0,1,.001001,0]));assert.equal(c.flush().position,2n);
 assert.throws(()=>c.append(new Float64Array(200001*3)),/capacity/);
 for(let i=0;i<100;i++){using temp=new StepCompressor(settings);temp.append(rows(10));assert.equal(temp.flush().position,10n);}
});
test('reconstructed compressed pulse times stay within the configured error window',()=>{
 const ticks:number[]=[],input:number[]=[];let clock=1000;
 for(let i=0;i<2000;i++){clock+=250+i%90;ticks.push(clock);input.push(1,0,clock/1e6);}
 using c=new StepCompressor({...settings,maxError:25});c.append(new Float64Array(input));const result=c.flush();
 const actual:bigint[]=[];
 for(let offset=result.history.length-6;offset>=0;offset-=6){const [first,, ,count,interval,add]=result.history.subarray(offset,offset+6);for(let i=0n;i<count;i++)actual.push(first+i*interval+add*i*(i+1n)/2n);}
 assert.equal(actual.length,ticks.length);
 actual.forEach((t,i)=>assert(t<=BigInt(ticks[i])&&t>=BigInt(ticks[i]-25)));
});
