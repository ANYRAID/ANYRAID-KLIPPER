import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCommand,rawParameters,extendedParameters} from '../src/gcode/parser.ts';
import {GCodeMove} from '../src/gcode/move.ts';
test('compact commands, numbered checksums, duplicate axes and comments retain Klipper parsing',()=>{
 const p=parseCommand('  N12 g1x1.25y-2X3*42 ; trailing ');
 assert.equal(p.command,'G1');assert.deepEqual({...p.params},{N:'12',G:'1',X:'3',Y:'-2','*':'42'});
 assert.equal(rawParameters(parseCommand('N12 M117 Ready now*42')),'Ready now');
 assert.equal(parseCommand('; comment').command,'');
 // E is an axis token, not an exponent, in traditional G-code.
 assert.deepEqual({...parseCommand('G1X1e-3').params},{G:'1',X:'1',E:'-3'});
});
test('extended quoting preserves case, spaces, escapes, comments and last duplicate',()=>{
 const p=parseCommand(String.raw`SET_TEST NAME="MiXeD ; # value" A='a b' B=a\ b NAME="last" C="a\qb" D=x=y # tail`);
 assert.deepEqual({...extendedParameters(p)},{NAME:'last',A:'a b',B:'a b',C:'a\\qb',D:'x=y'});
 for(const line of ['SET_TEST NAME="broken','SET_TEST NAME=x\\','SET_TEST missing'])assert.throws(()=>extendedParameters(parseCommand(line)),SyntaxError);
 assert.equal(Object.getPrototypeOf(extendedParameters(parseCommand('SET_TEST __proto__=value'))),null);
});
test('line bounds reject embedded commands before movement',()=>{
 for(const line of ['G1X1\nG1X2','G1\r','G1\0',' '.repeat(65537)])assert.throws(()=>parseCommand(line));
});
test('text commands enter the coordinate layer with native G-code mode semantics',()=>{
 let position=[0,0,0,0];const g=new GCodeMove({position:()=>position,move:p=>{position=[...p];}});
 for(const text of ['G1X10Y2E1F600','SAVE_GCODE_STATE NAME="pause"','G91','G1X2E-1','RESTORE_GCODE_STATE NAME=pause MOVE=1']) {
  const p=parseCommand(text);g.execute(p.command,p.command.includes('_')?extendedParameters(p):p.params);
 }
 assert.deepEqual(position,[10,2,0,0]);assert.equal(g.gcodePosition[3],1);
});
