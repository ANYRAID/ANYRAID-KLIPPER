// Request address selection for pinned Moonraker/Tornado xheaders.
// Original Moonraker Copyright (C) 2020 Eric Callahan. GPL-3.0-or-later.
import {isIP} from 'node:net';
import type {IncomingMessage} from 'node:http';
import {authorizationAddress} from './authorization-policy.ts';
export interface ProxyAddress {readonly peer:string|undefined;readonly claimed:string|undefined;readonly invalid:boolean;}
/** Parse once per request; never mutate the socket or delegate a header by itself.
 * Tornado chooses the last XFF item, then X-Real-IP. Forwarded is not consumed.
 * Malformed present claims cannot fall back to an anonymous trusted-proxy grant. */
export function proxyAddress(request:IncomingMessage,useXheaders=true):ProxyAddress{
 const raw=request.socket.remoteAddress,peer=typeof raw==='string'&&isIP(raw)?authorizationAddress(raw):undefined;
 if(!useXheaders)return Object.freeze({peer,claimed:undefined,invalid:false});
 const real=request.headers['x-real-ip'],forwarded=request.headers['x-forwarded-for'];
 if(real===undefined&&forwarded===undefined)return Object.freeze({peer,claimed:undefined,invalid:false});
 const value=real??(typeof forwarded==='string'?forwarded.slice(forwarded.lastIndexOf(',')+1).trim():forwarded);
 const valid=typeof value==='string'&&value.length<=4096&&isIP(value);
 return Object.freeze({peer,claimed:valid?authorizationAddress(value):undefined,invalid:!valid});
}
