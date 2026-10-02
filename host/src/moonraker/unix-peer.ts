import {Socket} from 'node:net';
import {createRequire} from 'node:module';
export interface UnixPeerCredentials {readonly process_id:number;readonly user_id:number;readonly group_id:number;}
interface Native {credentials(fd:number):UnixPeerCredentials;}
let native:Native|undefined;
/** Node 26 has no public socket descriptor accessor. Keep the private handle
 * dependency here, check it on every call, and read synchronously so JavaScript
 * cannot close/reuse the descriptor between inspection and getsockopt. */
export function unixPeerCredentials(socket:Socket):UnixPeerCredentials{
 if(!(socket instanceof Socket)||socket.destroyed||socket.pending||socket.connecting||socket.readyState!=='open')throw new Error('Unix socket is not connected');
 const fd=(socket as Socket&{_handle?:{fd?:number}})._handle?.fd;
 if(typeof fd!=='number'||!Number.isSafeInteger(fd)||fd<0)throw new Error('Node socket descriptor is unavailable');
 native??=createRequire(import.meta.url)(process.env.ANYRAID_UNIX_PEER_ADDON??'../../build/unix-peer.node') as Native;
 return Object.freeze(native.credentials(fd));
}
