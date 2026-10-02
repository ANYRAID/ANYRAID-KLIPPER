import test from 'node:test';
import assert from 'node:assert/strict';
import {consoleNumber,evaluateConsoleArithmetic,substituteConsoleArithmetic} from '../src/diagnostics/console-arithmetic.ts';
const vars=new Map([['clock',9007199254740993n],['freq',1000000n]]);
test('console clocks above 2^53 remain exact through decimal delays and wire masking',()=>{
 assert.equal(substituteConsoleArithmetic('DELAY {clock + freq * .2} reset_step_clock oid=4 clock={(clock + freq * .2) & 0xffffffff}',vars),'DELAY 9007199254940993 reset_step_clock oid=4 clock=200001');
 assert.equal(substituteConsoleArithmetic('{0.1+0.2-0.3} {-1.9} {1.9}',vars),'0 -1 1');
});
test('precedence, floor division, negative modulus and exponent match explicit references',()=>{
 for(const [expression,expected] of [['2+3*4','14'],['-2**2','-4'],['(-2)**2','4'],['2**3**2','512'],['-7//3','-3'],['-7%3','2'],['7%-3','-2'],['(1<<40)>>8','4294967296'],['~0 & 255','255'],['0xff ^ 0b11','252'],['1e3*.025','25']] as const)assert.equal(substituteConsoleArithmetic('{'+expression+'}',vars),expected,expression);
 assert.deepEqual(evaluateConsoleArithmetic('2**-2',vars),{numerator:1n,denominator:4n});assert.deepEqual(consoleNumber('-0x10'),{numerator:-16n,denominator:1n});
});
test('calls, property access, malformed arithmetic and unbounded work are rejected',()=>{
 for(const expression of ['process.exit()','__import__("os")','clock.constructor','1/0','1//0','2**1000000','1<<1000000','1e99999','unknown','1 +','1 2','1.2 & 1','('.repeat(65)+'1'+')'.repeat(65),'1+'.repeat(300)+'1'])assert.throws(()=>evaluateConsoleArithmetic(expression,vars),/.*/,expression);
 for(const line of ['{1','1}','{{1}}','{1}'.repeat(65)])assert.throws(()=>substituteConsoleArithmetic(line,vars));
});
test('boundary clocks preserve every integer through repeated expression conversion',()=>{
 for(const base of [0n,0xffffffffn,9007199254740993n,0xffffffffffffffffn])for(let delta=-100;delta<=100;delta++)assert.equal(substituteConsoleArithmetic('{clock + offset}',new Map([['clock',base],['offset',BigInt(delta)]])),String(base+BigInt(delta)));
});
