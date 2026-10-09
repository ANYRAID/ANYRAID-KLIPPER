// Local-user contracts from pinned Moonraker authorization.py; GPL-3.0-or-later.
import {createPrivateKey,createPublicKey,pbkdf2,randomBytes,sign,verify,timingSafeEqual,type KeyObject} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
export type AuthenticationSource='moonraker'|'ldap';
/** Explicit directory owner dependency. It must perform actual authentication,
 * honor cancellation, and retain no caller password after the operation. */
export interface LdapAuthenticator {authenticate(username:string,password:string,signal:AbortSignal):Promise<void>;}
export interface LocalUserOptions {issuer:string;loginTimeoutDays?:number;forceLogins?:boolean;now?:()=>number;defaultSource?:AuthenticationSource;ldap?:LdapAuthenticator;}
export interface UserChange {kind:'user_created'|'user_logged_out'|'user_deleted';username:string;revokedKid?:string|null;}
export type UserCommitted=(change:UserChange)=>void;
interface User {username:string;password:string;salt:string;created_on:number;source:AuthenticationSource;jwt_secret:string|null;jwk_id:string|null;}
interface Keys {privateKey:KeyObject;publicKey:KeyObject;}
interface Claim {username:string;kid:string;exp:number;}
const reserved=new Set(['_API_KEY_USER_','_TRUSTED_USER_']);
const hex64=/^[a-f0-9]{64}$/u;
function text(value:unknown,name:string,max=4096):string{if(typeof value!=='string'||!value.isWellFormed()||!value.length||Buffer.byteLength(value)>max||value.includes('\0'))throw new ApiError(400,'Invalid '+name);return value;}
function username(value:unknown){const name=text(value,'username',256);if(reserved.has(name))throw new ApiError(400,'Reserved username');return name;}
function keys(seed:string):Keys{const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.from(seed,'hex')]),format:'der',type:'pkcs8'});return {privateKey,publicKey:createPublicKey(privateKey)};}
const hash=(password:string,salt:string)=>new Promise<string>((resolve,reject)=>pbkdf2(password,Buffer.from(salt,'hex'),100000,32,'sha256',(error,key)=>error?reject(error):resolve(key.toString('hex'))));
const equal=(a:string,b:string)=>timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
const publicUser=(u:User)=>({username:u.username,source:u.source,created_on:u.created_on});
async function directoryAuthentication(ldap:LdapAuthenticator,name:string,password:string,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();let aborted:()=>void=()=>{};
 const cancellation=new Promise<never>((_resolve,reject)=>{aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});});
 try{await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return ldap.authenticate(name,password,signal);}),cancellation]);signal.throwIfAborted();}
 catch{signal.throwIfAborted();throw new ApiError(401,'LDAP authentication failed');}
 finally{signal.removeEventListener('abort',aborted);}
}
/** Serialized durable mutations, asynchronous password hashing, bounded token
 * cache. Committed logout/delete invalidates cache entries through live kid checks. */
export class LocalUserAuthorization {
 readonly #database:DatabaseStore;readonly #store:DatabaseNamespace;readonly #issuer:string;readonly #days:number;readonly #now:()=>number;readonly forceLogins:boolean;
 readonly defaultSource:AuthenticationSource;readonly #ldap:LdapAuthenticator|undefined;readonly #directoryLifetime=new AbortController();
 #users=new Map<string,User>();#keys=new Map<string,Keys>();#cache=new Map<string,Claim>();#tail:Promise<unknown>=Promise.resolve();#pending=0;#closed=false;
 private constructor(database:DatabaseStore,store:DatabaseNamespace,options:LocalUserOptions){this.#database=database;this.#store=store;this.#issuer=options.issuer;this.#days=options.loginTimeoutDays??90;this.#now=options.now??(()=>Date.now()/1000);this.forceLogins=options.forceLogins??false;this.defaultSource=options.defaultSource??'moonraker';this.#ldap=options.ldap;}
 static async open(database:DatabaseStore,options:LocalUserOptions){
  const issuer=new URL(options.issuer);if(!['http:','https:'].includes(issuer.protocol)||issuer.origin!==options.issuer||!Number.isSafeInteger(options.loginTimeoutDays??90)||(options.loginTimeoutDays??90)<1||(options.loginTimeoutDays??90)>3650||options.forceLogins!==undefined&&typeof options.forceLogins!=='boolean')throw new ApiError(400,'Invalid authorization settings');
  if(options.defaultSource!==undefined&&!['moonraker','ldap'].includes(options.defaultSource)||options.ldap!==undefined&&typeof options.ldap?.authenticate!=='function'||options.defaultSource==='ldap'&&!options.ldap)throw new ApiError(400,'Invalid authentication source settings');
  const store=await database.registerLocalNamespace('native_users',{forbidden:true,parseKeys:false}),owner=new LocalUserAuthorization(database,store,options),rows=await store.get('users',[]);
  if(!Array.isArray(rows)||rows.length>128)throw new ApiError(500,'Invalid persisted users');
  for(const row of rows){if(!row||typeof row!=='object'||Array.isArray(row))throw new ApiError(500,'Invalid persisted user');const u=row as unknown as User;try{username(u.username);const validPassword=u.source==='moonraker'?hex64.test(u.password)&&hex64.test(u.salt):u.source==='ldap'&&u.password===''&&u.salt==='';if(owner.#users.has(u.username)||!validPassword||!Number.isFinite(u.created_on)||u.created_on<0||(u.jwt_secret===null)!==(u.jwk_id===null)||u.jwt_secret!==null&&(!hex64.test(u.jwt_secret)||typeof u.jwk_id!=='string'||!(/^[A-Za-z0-9_-]{43}$/u.test(u.jwk_id))))throw Error('invalid');}catch{throw new ApiError(500,'Invalid persisted user');}owner.#users.set(u.username,Object.freeze({...u}));if(u.jwt_secret)owner.#keys.set(u.username,keys(u.jwt_secret));}
  return owner;
 }
 #active(){const s=this.#database.status;if(this.#closed||s.closed||s.closing||s.restoreState!=='ready')throw new ApiError(503,'User authorization unavailable');}
 #time(){const value=this.#now();if(!Number.isFinite(value)||value<0)throw new ApiError(503,'Invalid authorization clock');return Math.floor(value);}
 get count(){this.#active();return this.#users.size;}
 get availableSources():readonly AuthenticationSource[]{this.#active();return this.#ldap?['moonraker','ldap']:['moonraker'];}
 #run<T>(signal:AbortSignal,work:()=>Promise<T>):Promise<T>{
  this.#active();signal.throwIfAborted();if(this.#pending>=32)throw new ApiError(429,'Authorization queue is full');this.#pending++;
  const run=this.#tail.then(()=>{this.#active();signal.throwIfAborted();return work();});this.#tail=run.catch(()=>{});void run.finally(()=>{this.#pending--;}).catch(()=>{});return run;
 }
 async #save(users:Map<string,User>){try{await this.#store.insert('users',[...users.values()] as unknown as Json);this.#users=users;this.#keys=new Map([...users].filter(([,u])=>u.jwt_secret!==null).map(([name,u])=>[name,keys(u.jwt_secret!)]));this.#cache.clear();}catch(error){this.#closed=true;this.#cache.clear();throw error;}}
 #user(name:string){const u=this.#users.get(name);if(!u)throw new ApiError(400,'No registered user');return u;}
 #token(u:User,type:'access'|'refresh'){
  this.#active();const now=this.#time(),encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url'),message=encode({kid:u.jwk_id,alg:'EdDSA',typ:'JWT'})+'.'+encode({iss:this.#issuer,aud:'Moonraker',iat:now,exp:now+(type==='access'?3600:this.#days*86400),username:u.username,token_type:type});
  return message+'.'+sign(null,Buffer.from(message),this.#keys.get(u.username)!.privateKey).toString('base64url');
 }
 decode(token:unknown,type:'access'|'refresh'='access',checkExpiry=true):{username:string}{
  this.#active();if(typeof token!=='string'||token.length>8192)throw new ApiError(401,'Invalid JWT');const key=type+':'+token,now=this.#time(),cached=this.#cache.get(key);
  if(cached){if((!checkExpiry||cached.exp>=now)&&this.#users.get(cached.username)?.jwk_id===cached.kid)return {username:cached.username};this.#cache.delete(key);}
  try{
   const parts=token.split('.');if(parts.length!==3||parts.some(p=>!p||!(/^[A-Za-z0-9_-]+$/u.test(p))))throw Error();
   const decode=(p:string)=>{const b=Buffer.from(p,'base64url');if(b.toString('base64url')!==p)throw Error();return b;};
   const h=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[0]))),p=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(decode(parts[1]))),signature=decode(parts[2]);
   if(!h||!p||h.alg!=='EdDSA'||h.typ!=='JWT'||typeof h.kid!=='string'||typeof p.username!=='string'||p.iss!==this.#issuer||p.aud!=='Moonraker'||p.token_type!==type||!Number.isSafeInteger(p.exp)||!Number.isSafeInteger(p.iat)||checkExpiry&&p.exp<now||signature.length!==64)throw Error();
   const u=this.#users.get(p.username),pair=this.#keys.get(p.username);if(!u||!pair||u.jwk_id!==h.kid||!verify(null,Buffer.from(parts[0]+'.'+parts[1]),pair.publicKey,signature))throw Error();
   if(this.#cache.size>=1024)this.#cache.delete(this.#cache.keys().next().value!);this.#cache.set(key,{username:u.username,kid:h.kid,exp:p.exp});return {username:u.username};
  }catch{throw new ApiError(401,'Invalid or expired JWT');}
 }
 login(params:Readonly<Record<string,Json>>,signal:AbortSignal,create=false,committed?:UserCommitted){
  const name=username(params.username),password=text(params.password,'password'),requested=params.source??this.defaultSource;
  if(typeof requested!=='string'||!['moonraker','ldap'].includes(requested.toLowerCase()))throw new ApiError(400,'Invalid authentication source');const source=requested.toLowerCase() as AuthenticationSource;
  if(source==='ldap'&&create)throw new ApiError(400,'Cannot create LDAP user');if(source==='ldap'&&!this.#ldap)throw new ApiError(401,'LDAP authentication unavailable');
  return this.#run(signal,async()=>{
   if(source==='ldap'){await directoryAuthentication(this.#ldap!,name,password,AbortSignal.any([signal,this.#directoryLifetime.signal]));this.#active();}
   let u:User;const needCreate=create||source==='ldap'&&!this.#users.has(name);
   if(needCreate){if(this.#users.has(name))throw new ApiError(400,'User already exists');if(this.#users.size>=128)throw new ApiError(429,'User capacity exceeded');const salt=source==='moonraker'?randomBytes(32).toString('hex'):'';u={username:name,password:source==='moonraker'?await hash(password,salt):'',salt,created_on:this.#time(),source,jwt_secret:null,jwk_id:null};}
   else{u=this.#user(name);if(u.source!==source)throw new ApiError(401,'Authentication source does not match registered user');if(source==='moonraker'&&!equal(await hash(password,u.salt),u.password))throw new ApiError(400,'Invalid Password');}
   signal.throwIfAborted();if(!u.jwt_secret){u={...u,jwt_secret:randomBytes(32).toString('hex'),jwk_id:randomBytes(32).toString('base64url')};const next=new Map(this.#users);next.set(name,u);await this.#save(next);}
   if(create)committed?.({kind:'user_created',username:name});
   return {username:name,token:this.#token(u,'access'),source:u.source,refresh_token:this.#token(u,'refresh'),action:create?'user_created':'user_logged_in'};
  });
 }
 refresh(token:unknown){this.#active();const {username}=this.decode(token,'refresh'),u=this.#user(username);return {username,token:this.#token(u,'access'),source:u.source,action:'user_jwt_refresh'};}
 user(name:string){this.#active();return publicUser(this.#user(name));}
 list(){this.#active();return {users:[...this.#users.values()].map(publicUser)};}
 logout(name:string,signal:AbortSignal,committed?:UserCommitted){username(name);return this.#run(signal,async()=>{const u=this.#user(name),next=new Map(this.#users);next.set(name,{...u,jwt_secret:null,jwk_id:null});await this.#save(next);committed?.({kind:'user_logged_out',username:name,revokedKid:u.jwk_id});return {username:name,action:'user_logged_out'};});}
 delete(name:unknown,actor:string,signal:AbortSignal,committed?:UserCommitted){const target=username(name);if(target===actor)throw new ApiError(400,'Cannot delete logged in user');return this.#run(signal,async()=>{const u=this.#user(target);const next=new Map(this.#users);next.delete(target);await this.#save(next);committed?.({kind:'user_deleted',username:target,revokedKid:u.jwk_id});return {username:target,action:'user_deleted'};});}
 password(name:string,params:Readonly<Record<string,Json>>,signal:AbortSignal){username(name);const old=text(params.password,'password'),nextPassword=text(params.new_password,'new_password');return this.#run(signal,async()=>{const u=this.#user(name);if(u.source!=='moonraker')throw new ApiError(400,'Cannot reset LDAP user password');if(!equal(await hash(old,u.salt),u.password))throw new ApiError(400,'Invalid Password');const password=await hash(nextPassword,u.salt);signal.throwIfAborted();const next=new Map(this.#users);next.set(name,{...u,password});await this.#save(next);return {username:name,action:'user_password_reset'};});}
 async close(){this.#closed=true;this.#directoryLifetime.abort(new ApiError(503,'User authorization closed'));await this.#tail;this.#cache.clear();}
}
