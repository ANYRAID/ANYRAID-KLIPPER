import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
export async function klippyMqttPeer(){
 const directory=await mkdtemp(join(tmpdir(),'klippy-mqtt-')),path=join(directory,'api.sock'),sockets:Socket[]=[],requests:any[]=[];
 const server=createServer(socket=>{sockets.push(socket);socket.on('error',()=>{});let tail='';socket.on('data',data=>{tail+=data.toString();for(let end;(end=tail.indexOf('\x03'))>=0;){const m=JSON.parse(tail.slice(0,end));tail=tail.slice(end+1);requests.push(m);let result:unknown={};
  if(m.method==='info')result={state:'ready',state_message:'ready',software_version:'test'};
  else if(m.method==='list_endpoints')result={endpoints:['info','list_endpoints','objects/subscribe','objects/list','gcode/subscribe_output','register_remote_method']};
  else if(m.method==='objects/list')result={objects:['virtual_sdcard','display_status','pause_resume']};
  else if(m.method==='objects/subscribe')result={eventtime:1,status:{webhooks:{state:'ready',state_message:'ready'}}};
  socket.write(JSON.stringify({id:m.id,result})+'\x03');
 }});});server.listen(path);await once(server,'listening');
 return {path,requests,sockets,send(method:string,params:unknown){sockets.at(-1)!.write(JSON.stringify({method,params})+'\x03');},drop(){for(const socket of sockets)socket.destroy();},async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));await rm(directory,{recursive:true,force:true});}};
}
