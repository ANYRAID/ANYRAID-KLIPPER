// Moonraker versions.py at 1cfb0c41e468645951a371621f06d32777b6107c.
// GPL-3.0-or-later. This is GitVersion compatibility, not SemVer/PEP 440.
export const MAX_GIT_VERSION_LENGTH=4096;
const FINAL=1,ALPHA=2,BETA=4,RELEASE_CANDIDATE=8,DEV=32;
// Python str.strip()/re \s include these characters, and exclude U+FEFF.
const whitespace=/^[\x09-\x0d\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
const strip=(value:string)=>{
 let first=0,last=value.length;while(first<last&&whitespace.test(value[first]))first++;while(last>first&&whitespace.test(value[last-1]))last--;return value.slice(first,last);
};
// Every repeated numeric token is separated by a literal delimiter; no nested
// ambiguous quantifiers. The protocol's 4096-code-unit cap bounds all work,
// including BigInt conversion, tuple allocation and malformed fallback input.
const versionPattern=/^(?<tag>v?(?<release>[0-9]+(?:\.[0-9]+)*)(?<pre>[-_.]?(?<label>a|b|c|rc|alpha|beta|pre|preview)[-_.]?(?<number>[0-9]+)?)?)(?:-(?<dev>[0-9]+)(?:-g[a-f0-9]+)?)?(?<dirty>-dirty)?(?<inferred>-(?:inferred|shallow))?$/u;
// Python re.IGNORECASE additionally recognizes these ASCII letter equivalents.
const fold=(value:string)=>value.replace(/[\u0130\u0131]/gu,'i').replace(/\u017f/gu,'s').replace(/\u212a/gu,'k').toLowerCase();
const tupleCompare=(left:readonly bigint[],right:readonly bigint[]):number=>{
 for(let at=0;at<Math.min(left.length,right.length);at++){if(left[at]<right[at])return -1;if(left[at]>right[at])return 1;}
 return left.length<right.length?-1:left.length>right.length?1:0;
};

class BaseVersion {
 protected _release='?';protected _tag='?';protected _type=0;protected _valid=false;
 protected _releaseTuple:bigint[]=[];protected _extraTuple:bigint[]=[];
 protected _hasDevPart=false;protected _devCount=0n;
 readonly fullVersion:string;
 constructor(version:string){
  if(typeof version!=='string')throw new TypeError('Git version must be a string');
  if(version.length>MAX_GIT_VERSION_LENGTH)throw new RangeError('Git version exceeds 4096 characters');
  this.fullVersion=strip(version);
 }
 get shortVersion(){return this._valid?`${this._tag}-${this._devCount}`:'?';}
 get release(){return this._release;}
 get tag(){return this._tag;}
 get devCount(){return this._devCount;}
 get isValid(){return this._valid;}
 get isFinal(){return Boolean(this._type&FINAL);}
 get isAlpha(){return Boolean(this._type&ALPHA);}
 get isBeta(){return Boolean(this._type&BETA);}
 get isReleaseCandidate(){return Boolean(this._type&RELEASE_CANDIDATE);}
 get isPreRelease(){return Boolean(this._type&(ALPHA|BETA|RELEASE_CANDIDATE));}
 get isDev(){return Boolean(this._type&DEV);}
 toString(){return this.fullVersion;}
 protected validate(other:BaseVersion):void{
  if(!(other instanceof this.constructor))throw new TypeError('Invalid type for comparison');
  if(!this._valid||!other._valid)throw new TypeError('Invalid Git version for comparison');
 }
 equals(other:BaseVersion):boolean{this.validate(other);return tupleCompare(this._releaseTuple,other._releaseTuple)===0&&tupleCompare(this._extraTuple,other._extraTuple)===0&&this._hasDevPart===other._hasDevPart&&this._devCount===other._devCount;}
 notEquals(other:BaseVersion):boolean{return !this.equals(other);}
 lessThan(other:BaseVersion):boolean{
  this.validate(other);const release=tupleCompare(this._releaseTuple,other._releaseTuple);if(release!==0)return release<0;
  const extra=tupleCompare(this._extraTuple,other._extraTuple);if(extra!==0)return extra<0;
  return this._hasDevPart!==other._hasDevPart?this._hasDevPart:this._devCount<other._devCount;
 }
 greaterThan(other:BaseVersion):boolean{
  this.validate(other);const release=tupleCompare(this._releaseTuple,other._releaseTuple);if(release!==0)return release>0;
  const extra=tupleCompare(this._extraTuple,other._extraTuple);if(extra!==0)return extra>0;
  return this._hasDevPart!==other._hasDevPart?other._hasDevPart:this._devCount>other._devCount;
 }
 // Preserve upstream BaseVersion.__le__/__ge__ component vetoes. These are NOT
 // lexicographic <=/>= and must not be replaced by lessThan||equals: _set_versions
 // uses __le__ to choose the update version, including its inconsistent cases.
 lessEqual(other:BaseVersion):boolean{
  this.validate(other);if(tupleCompare(this._releaseTuple,other._releaseTuple)>0)return false;
  if(tupleCompare(this._extraTuple,other._extraTuple)>0)return false;
  return this._hasDevPart!==other._hasDevPart?this._hasDevPart:this._devCount<=other._devCount;
 }
 greaterEqual(other:BaseVersion):boolean{
  this.validate(other);if(tupleCompare(this._releaseTuple,other._releaseTuple)<0)return false;
  if(tupleCompare(this._extraTuple,other._extraTuple)<0)return false;
  return this._hasDevPart!==other._hasDevPart?other._hasDevPart:this._devCount>=other._devCount;
 }
}

export class GitVersion extends BaseVersion {
 readonly dirty:boolean=false;readonly inferred:boolean=false;
 constructor(version:string){
  super(version);const match=versionPattern.exec(fold(this.fullVersion));
  if(!match?.groups){
   // Upstream fallback deliberately has no end anchor and is case sensitive
   // for '-dirty'. It retains metadata but is never a comparable valid version.
   const fallback=/^(?<hash>[a-fA-F0-9]+)(?<dirty>-dirty)?/u.exec(this.fullVersion)?.groups;
   if(fallback){this._tag='';this._release=fallback.hash;this.dirty=fallback.dirty!==undefined;this.inferred=true;}
   return;
  }
  const info=match.groups;this._valid=true;this._release=info.release;
  this._tag=this.fullVersion.slice(0,info.tag.length);this._releaseTuple=info.release.split('.').map(part=>BigInt(part));this._extraTuple=[1n,0n,0n];
  if(info.pre!==undefined){const kind=info.label[0]==='a'?1:info.label[0]==='b'?2:3;this._extraTuple=[0n,BigInt(kind),BigInt(info.number??'0')];this._type=1<<kind;}
  // All Git versions have a dev part; positive counts sort after the same tag.
  this._hasDevPart=true;this._devCount=BigInt(info.dev??'0');if(this._devCount>0n)this._type|=DEV;if(this._type===0)this._type=FINAL;
  this.dirty=info.dirty!==undefined;this.inferred=info.inferred!==undefined;
 }
 get isFallback(){return this.inferred&&!this.isValid;}
 inferLastTag():string{
  if(!this.isValid)return 'v0.0.0';
  if(this.inferred)return this.tag;
  if(this.isPreRelease&&tupleCompare(this._extraTuple,[0n,1n,0n])>0){
   let kind=this._extraTuple[1],count=this._extraTuple[2];if(count===0n)kind--;else count--;
   return `${this.release}.${kind===1n?'a':kind===2n?'b':'rc'}${count}`;
  }
  const parts=[...this._releaseTuple];for(let at=parts.length-1;at>=0;at--)if(parts[at]>0n){parts[at]--;break;}
  return 'v'+parts.join('.');
 }
}
export const parseGitVersion=(version:string):GitVersion=>new GitVersion(version);
