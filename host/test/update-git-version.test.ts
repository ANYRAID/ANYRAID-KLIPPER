import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {GitVersion,parseGitVersion,MAX_GIT_VERSION_LENGTH} from '../src/moonraker/update-git-version.ts';

// Hand-derived from Moonraker versions.py, commit
// 1cfb0c41e468645951a371621f06d32777b6107c (SHA-256
// cd1055449b9c52c2a27faa8e2f0b6dd6b086b285f486f61269ac9768d6daa243).
// These expectations intentionally preserve non-SemVer tuple and <= semantics.
test('Git descriptions preserve textual tag and normalize only the count',()=>{
 for(const [raw,tag,release,count,dirty,inferred] of [
  ['v1.2.3','v1.2.3','1.2.3',0n,false,false],
  [' V01.002-0003-gAbC09-DIRTY-SHALLOW ','V01.002','01.002',3n,true,true],
  ['0-0','0','0',0n,false,false],
  ['1.2-dirty','1.2','1.2',0n,true,false],
  ['1.2-inferred','1.2','1.2',0n,false,true],
  ['v1.2-7','v1.2','1.2',7n,false,false],
  ['1.2rc--2-gf','1.2rc-','1.2',2n,false,false],
 ] as const){const version=parseGitVersion(raw);assert.equal(version.isValid,true,raw);assert.equal(version.tag,tag);assert.equal(version.release,release);assert.equal(version.devCount,count);assert.equal(version.shortVersion,`${tag}-${count}`);assert.equal(version.dirty,dirty);assert.equal(version.inferred,inferred);assert.equal(version.isFallback,false);assert.equal(version.fullVersion,raw.trim());assert.equal(String(version),raw.trim());}
});

test('pre-release aliases, optional separators and omitted counts follow pinned flags',()=>{
 for(const [label,kind] of [['a','a'],['alpha','a'],['b','b'],['beta','b'],['c','rc'],['rc','rc'],['pre','rc'],['preview','rc']] as const){
  for(const spelling of [`1.2${label}`,`v1.2_${label.toUpperCase()}.002`,`1.2-${label}-`]){
   const version=new GitVersion(spelling);assert.equal(version.isValid,true,spelling);assert.equal(version.isPreRelease,true);assert.equal(version.isFinal,false);assert.equal(version.isAlpha,kind==='a');assert.equal(version.isBeta,kind==='b');assert.equal(version.isReleaseCandidate,kind==='rc');assert.equal(version.isDev,false);
  }
 }
 assert.equal(new GitVersion('v1.0-0-gabc').isFinal,true);
 assert.equal(new GitVersion('v1.0-1-gabc').isFinal,false);assert.equal(new GitVersion('v1.0-1-gabc').isDev,true);
 assert.equal(new GitVersion('v1.0a2-1-gabc').isAlpha,true);assert.equal(new GitVersion('v1.0a2-1-gabc').isDev,true);
});

test('invalid main grammar retains only upstream fallback metadata',()=>{
 for(const raw of ['', '?','v','vv1','v1..2','v1+local','v1.dev2','v1-2-g','v1-gabc','v1-2-gxyz','v1-shallow-dirty','v1-dirty-extra','v1-post1','-1','∞','v1\n.2']){
  const version=new GitVersion(raw);assert.equal(version.isValid,false,raw);assert.equal(version.shortVersion,'?');assert.equal(version.tag,'?');assert.equal(version.release,'?');assert.equal(version.inferred,false);assert.equal(version.isFallback,false);assert.equal(version.isFinal,false);assert.equal(version.isDev,false);
 }
 for(const [raw,release,dirty] of [['deadBEEF','deadBEEF',false],['abcdef-dirty','abcdef',true],['abcdef-dirty-trailing','abcdef',true],['abcdef-DIRTY','abcdef',false],['1.2+local','1',false],['1e3','1e3',false],['0x10','0',false],['bad-version','bad',false]] as const){
  const version=new GitVersion(raw);assert.equal(version.isValid,false,raw);assert.equal(version.release,release);assert.equal(version.tag,'');assert.equal(version.dirty,dirty);assert.equal(version.inferred,true);assert.equal(version.isFallback,true);assert.equal(version.shortVersion,'?');assert.equal(version.inferLastTag(),'v0.0.0');
 }
});

test('Python whitespace and case-insensitive literals remain compatible',()=>{
 const version=new GitVersion('\x1c\x85\u3000V1.PREVİEW2-3-gABC-DİRTY-ſHALLOW\u2007\x1f');
 assert.equal(version.isValid,true);assert.equal(version.tag,'V1.PREVİEW2');assert.equal(version.dirty,true);assert.equal(version.inferred,true);assert.equal(version.isReleaseCandidate,true);assert.equal(version.fullVersion,'V1.PREVİEW2-3-gABC-DİRTY-ſHALLOW');
 assert.equal(new GitVersion('\ufeffv1').isValid,false);assert.equal(new GitVersion('v1\ufeff').isValid,false);
});

test('integer segments and development counts keep arbitrary precision',()=>{
 const low=new GitVersion('v9007199254740992.0a9007199254740992-9007199254740992-gabc');
 const high=new GitVersion('v9007199254740993.0a9007199254740993-9007199254740993-gdef');
 assert.equal(low.lessThan(high),true);assert.equal(low.lessEqual(high),true);assert.equal(low.equals(high),false);assert.equal(high.devCount,9007199254740993n);
 assert.equal(new GitVersion('1a9007199254740992').lessThan(new GitVersion('1a9007199254740993')),true);
 assert.equal(new GitVersion('1-9007199254740992').lessThan(new GitVersion('1-9007199254740993')),true);
 assert.equal(new GitVersion('v9007199254740993.0.0').inferLastTag(),'v9007199254740992.0.0');
 assert.equal(high.inferLastTag(),'9007199254740993.0.a9007199254740992');
});

test('release tuples are length-sensitive, with leading zeros normalized for comparison',()=>{
 for(const [left,right] of [['1','1.0'],['1.0','1.0.0'],['0','0.0'],['0.0','0.0.0'],['1.2.0','1.2.0.0']] as const){const a=new GitVersion(left),b=new GitVersion(right);assert.equal(a.equals(b),false);assert.equal(a.notEquals(b),true);assert.equal(a.lessThan(b),true);assert.equal(a.lessEqual(b),true);assert.equal(b.greaterThan(a),true);assert.equal(b.greaterEqual(a),true);}
 const a=new GitVersion('V01.002-0000-gABC-dirty-inferred'),b=new GitVersion('1.2');assert.equal(a.equals(b),true);assert.equal(a.lessThan(b),false);assert.equal(a.greaterThan(b),false);assert.equal(a.lessEqual(b),true);assert.equal(a.greaterEqual(b),true);
 assert.equal(new GitVersion('1.0a01').equals(new GitVersion('v1.0-alpha-1')),true);
});

test('Git count sorts above the same final/pre-release tag',()=>{
 const ordered=['1.0a0','1.0a1','1.0b0','1.0rc0','1.0rc1','1.0','1.0-1','1.0-2'];
 for(let at=0;at<ordered.length-1;at++){const a=new GitVersion(ordered[at]),b=new GitVersion(ordered[at+1]);assert.equal(a.lessThan(b),true,`${a} < ${b}`);assert.equal(b.greaterThan(a),true);}
 assert.equal(new GitVersion('1.0a1').lessThan(new GitVersion('1.0a1-1')),true);
 assert.equal(new GitVersion('1.0-0-gabc').equals(new GitVersion('1.0')),true);
});

test('compatibility <= and >= preserve upstream component vetoes, even when strict order disagrees',()=>{
 // Release tuple is lower, but final's extra tuple is higher than alpha's.
 const lowerFinal=new GitVersion('1'),higherAlpha=new GitVersion('2a0');
 assert.equal(lowerFinal.lessThan(higherAlpha),true);assert.equal(lowerFinal.lessEqual(higherAlpha),false);assert.equal(higherAlpha.greaterThan(lowerFinal),true);assert.equal(higherAlpha.greaterEqual(lowerFinal),false);
 // Release and extra tuples permit <=, but the old release's count vetoes it.
 const oldDevelop=new GitVersion('1-20'),newRelease=new GitVersion('2');
 assert.equal(oldDevelop.lessThan(newRelease),true);assert.equal(oldDevelop.lessEqual(newRelease),false);assert.equal(newRelease.greaterThan(oldDevelop),true);assert.equal(newRelease.greaterEqual(oldDevelop),false);
 // Within one release the pre-release tuple can likewise be vetoed by count.
 const alpha=new GitVersion('1a0-7'),beta=new GitVersion('1b0-2');assert.equal(alpha.lessThan(beta),true);assert.equal(alpha.lessEqual(beta),false);assert.equal(beta.greaterEqual(alpha),false);
});

test('inferLastTag decrements the last nonzero release segment or previous pre-release stage',()=>{
 for(const [raw,expected] of [
  ['?','v0.0.0'],['abc','v0.0.0'],['v0','v0'],['v0.0.0','v0.0.0'],['v1.0.0','v0.0.0'],['2.0.0','v1.0.0'],['1.2.0.0','v1.1.0.0'],['V01.002.000','v1.1.0'],
  ['v1.2a0','v1.1'],['v1.2alpha1','1.2.a0'],['1.2b0','1.2.a0'],['1.2beta2','1.2.b1'],['v1.2rc0','1.2.b0'],['v1.2preview2','1.2.rc1'],
  ['V01.02_PREVIEW.02-7-gabc-inferred','V01.02_PREVIEW.02'],['v1.2-dirty-shallow','v1.2'],
 ] as const)assert.equal(new GitVersion(raw).inferLastTag(),expected,raw);
});

test('all comparison entry points reject invalid or wrong-type operands',()=>{
 const good=new GitVersion('1'),bad=new GitVersion('?'),fallback=new GitVersion('abc');
 for(const method of ['equals','notEquals','lessThan','lessEqual','greaterThan','greaterEqual'] as const){assert.throws(()=>good[method](bad),TypeError);assert.throws(()=>bad[method](good),TypeError);assert.throws(()=>fallback[method](good),TypeError);assert.throws(()=>good[method]({} as GitVersion),TypeError);assert.throws(()=>good[method](null as unknown as GitVersion),TypeError);}
});

test('version input cap bounds giant numeric and malformed descriptions',t=>{
 assert.equal(MAX_GIT_VERSION_LENGTH,4096);
 const maximum=new GitVersion('9'.repeat(MAX_GIT_VERSION_LENGTH));assert.equal(maximum.isValid,true);assert.equal(maximum.inferLastTag(),'v'+'9'.repeat(MAX_GIT_VERSION_LENGTH-1)+'8');
 assert.equal(new GitVersion('0.'.repeat(2047)+'0').isValid,true);
 for(const raw of ['9'.repeat(4097),' '.repeat(4097),'v1'+'-'.repeat(4095)])assert.throws(()=>new GitVersion(raw),RangeError);
 const samples=['v1.2.3-42-gabcdef-dirty','v1.2preview999-inferred','v'+'1.'.repeat(2046)+'1x','v1a'+'9'.repeat(4092)+'x'];
 const start=performance.now();for(let at=0;at<2000;at++)new GitVersion(samples[at%samples.length]);
 t.diagnostic(`Finite 2000-description parsing observation: ${(performance.now()-start).toFixed(3)} ms; no performance acceptance threshold`);
});
