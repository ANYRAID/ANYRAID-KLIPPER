import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pythonLower} from '../src/moonraker/python-lower.ts';
// CPython 3.12 / Unicode 15: UTF-8 lower(scalar) followed by NUL, in codepoint order.
test('pinned lowercase matches the Python baseline for every Unicode scalar',()=>{
 const hash=createHash('sha256');for(let cp=0;cp<=0x10ffff;cp++){if(cp>=0xd800&&cp<=0xdfff)continue;hash.update(pythonLower(String.fromCodePoint(cp)));hash.update('\0');}
 assert.equal(hash.digest('hex'),"2a57bd2ee31776aecc042336da11b34e1b6f16cd8c587e9bcdf885218ef3a961");
});
test('contextual Greek sigma preserves Python cased and ignorable rules',()=>{
 for(const [input,expected] of [["\u03a3", "\u03c3"], ["\u0391\u03a3", "\u03b1\u03c2"], ["\u0391\u03a3\u0391", "\u03b1\u03c3\u03b1"], ["\u0391\u0301\u03a3", "\u03b1\u0301\u03c2"], ["\u0391\u03a3\u0301\u0391", "\u03b1\u03c3\u0301\u03b1"], ["\u0391\u03a3\u0301", "\u03b1\u03c2\u0301"], ["\u0391\u03a3 .\u0391", "\u03b1\u03c2 .\u03b1"], ["\u02b0\u03a3", "\u02b0\u03c3"], ["\u03a3\u02b0", "\u03c3\u02b0"], ["\u039f\u03a3/\u03a3", "\u03bf\u03c2/\u03c3"], ["\u0130", "i\u0307"], ["\u1f88", "\u1f80"], ["\ud803\udd50\u03a3", "\ud803\udd50\u03c3"], ["A\u03a3\ud803\udd50", "a\u03c2\ud803\udd50"], ["A\u03a3\ud803\udd50A", "a\u03c2\ud803\udd50a"], ["A\u03a3\u0345", "a\u03c2\u0345"], ["A\u03a3\u0345A", "a\u03c3\u0345a"]])assert.equal(pythonLower(input),expected);
});
