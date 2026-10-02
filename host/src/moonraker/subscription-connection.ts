import {ApiError} from './rpc.ts';
/** HTTP association follows query/form connection_id, not JSON object fields.
 * Reject duplicate or lossy IDs instead of choosing an ambiguous connection. */
export function subscriptionConnectionId(url:string,body:Uint8Array,contentType:string):number{
 const at=url.indexOf('?'),query=new URLSearchParams(at<0?'':url.slice(at+1)),values=query.getAll('connection_id');
 if(contentType.split(';')[0].trim().toLowerCase()==='application/x-www-form-urlencoded'){let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new ApiError(400,'Invalid subscription form encoding');}values.push(...new URLSearchParams(text).getAll('connection_id'));}
 if(values.length!==1)throw new ApiError(400,'Exactly one connection_id is required');const text=values[0].trim(),id=Number(text);if(!/^[0-9]+$/.test(text)||!Number.isSafeInteger(id)||id<1)throw new ApiError(400,'Invalid subscription connection_id');return id;
}
