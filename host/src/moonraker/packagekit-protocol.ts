/** PackageKit v1.3.1 (0f33069752fe06f6daf3d977cd09665b059494d8),
 * src/org.freedesktop.PackageKit{,.Transaction}.xml and pk-enum.h.
 * Moonraker 1cfb0c41 thirdparty/packagekit/enums.py uses 1 << enum index.
 * Deliberately supports the existing org.freedesktop.PackageKit API only. */
export const packageKitName='org.freedesktop.PackageKit';
export const packageKitInterface=packageKitName+'.Transaction';
export const packageKitActions=['org.freedesktop.packagekit.system-sources-refresh','org.freedesktop.packagekit.package-install','org.freedesktop.packagekit.system-update'] as const;
export type PackageKitAction=typeof packageKitActions[number];
export const packageKitBits=Object.freeze({none:2n,resolve:(1n<<3n)|(1n<<14n)|(1n<<16n)|(1n<<18n),onlyTrusted:2n,success:1});
export type PackageKitRequest={method:'GetUpdates'|'RefreshCache'}|{method:'Resolve';names:readonly string[]}|{method:'InstallPackages'|'UpdatePackages';ids:readonly string[]};
export interface PackageKitPackage {info:number;package_id:string;summary:string;}
export interface PackageKitProgress {percentage?:number;status?:number;speed?:string;download_remaining?:string;}
export interface PackageKitIdentity {path:string;connection:number;owner:number;sender:string;}
export interface PackageKitHooks {beforeSubmit?:(identity:PackageKitIdentity,signal:AbortSignal)=>Promise<void>;submitted?:()=>void;progress?:(value:PackageKitProgress)=>void;}
export class PackageKitError extends Error {
 readonly outcome:'failed'|'unknown';readonly code:string;
 constructor(code:string,outcome:'failed'|'unknown'='failed'){super('PackageKit transaction '+code);this.name='PackageKitError';this.code=code;this.outcome=outcome;}
}
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.isWellFormed()&&Buffer.byteLength(value)<=max&&!/[\0\r\n]/u.test(value);
export const packageKitId=(value:unknown):value is string=>text(value,2048)&&value.split(';').length===4&&value.split(';').every((s,i)=>i===3||s.length>0);
export function packageKitNames(value:unknown):asserts value is string[]{if(!Array.isArray(value)||value.length<1||value.length>4096||value.some(name=>!text(name,256)||!/^[A-Za-z0-9][A-Za-z0-9+_.:-]*$/u.test(name)))throw new TypeError('Invalid PackageKit package names');}
export function packageKitCall(request:PackageKitRequest):{signature:string;body:unknown[];mutation:boolean}{
 if(!request||typeof request!=='object')throw new TypeError('Invalid PackageKit request');
 switch(request.method){
  case 'GetUpdates':if(Object.keys(request).length!==1)break;return {signature:'t',body:[packageKitBits.none],mutation:false};
  case 'RefreshCache':if(Object.keys(request).length!==1)break;return {signature:'b',body:[false],mutation:true};
  case 'Resolve':packageKitNames(request.names);if(Object.keys(request).length!==2)break;return {signature:'tas',body:[packageKitBits.resolve,[...request.names]],mutation:false};
  case 'InstallPackages':case 'UpdatePackages':if(Object.keys(request).length!==2||!Array.isArray(request.ids)||request.ids.length<1||request.ids.length>4096||request.ids.some(id=>!packageKitId(id)))break;return {signature:'tas',body:[packageKitBits.onlyTrusted,[...request.ids]],mutation:true};
 }
 throw new TypeError('Unsupported PackageKit request');
}
