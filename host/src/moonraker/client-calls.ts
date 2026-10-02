import {OutboundNotifications,type NotificationLimits} from './notifications.ts';
import {encodeClientMessage,type ClientArguments} from './client-requests.ts';
import {ApiError,validateJson} from './rpc.ts';
/** BaseRemoteConnection.call_method: a notification, with no response ID and
 * no reply to await. Empty arguments are omitted like the Python implementation. */
export function encodeClientCall(method:string,params:ClientArguments):string{
 if(typeof method!=='string'||!method||method.length>256||method.includes('\0'))throw new ApiError(400,'Invalid client method');
 if(params!==null&&(typeof params!=='object'||!params))throw new ApiError(400,'Client arguments must be an object or list');
 validateJson(params);
 const include=params!==null&&(Array.isArray(params)?params.length:Object.keys(params).length)>0;
 return encodeClientMessage({jsonrpc:'2.0',method,...include?{params}:{}});
}
/** Shares the bounded delivery implementation, with a separate authorization
 * policy and queue from Moonraker notify_* events and reply-bearing requests. */
export class ClientCalls extends OutboundNotifications<ClientArguments>{
 constructor(limits:NotificationLimits={}){super({encode:encodeClientCall,empty:null},limits);}
}
