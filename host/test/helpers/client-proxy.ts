import {WebSocket} from 'ws';
import type {IncomingHttpHeaders} from 'node:http';

/** Acceptance relay only. Preserve native identity, never synthesize
 * authority from a browser cookie or forward websocket handshake headers. */
export function clientProxyWebSocket(upstream:string,path:string,source:IncomingHttpHeaders):WebSocket {
 const headers:Record<string,string>={};
 for(const name of ['authorization','x-api-key','x-access-token','origin']){
  const value=source[name];
  if(value!==undefined){if(typeof value!=='string')throw new Error('Ambiguous client proxy header');headers[name]=name==='origin'?new URL(upstream).origin:value;}
 }
 return new WebSocket(upstream.replace('http:','ws:')+path,{headers});
}

/** The fixture adds one local relay hop; native origin checks must see the
 * destination listener, just as they do with the protected gateway directly. */
export function clientProxyRequestHeaders(upstream:string,source:IncomingHttpHeaders):IncomingHttpHeaders {
 const target=new URL(upstream);
 return {...source,host:target.host,...source.origin===undefined?{}:{origin:target.origin}};
}

/** Explicit software-fixture policy; queued jobs require operator clearance,
 * and neither process startup nor completion automatically starts a job. */
export function compiledClientMoonrakerConfig(original:string,trustedLoopback=false):string {
 const server=trustedLoopback?'[server]\nhost: 127.0.0.1\nport: 0\n[authorization]\ntrusted_clients: 127.0.0.1\nforce_logins: false\n':original;
 return server+'\n[job_queue]\nload_on_startup: false\nautomatic_transition: false\njob_transition_policy: operator_confirmation\n';
}
