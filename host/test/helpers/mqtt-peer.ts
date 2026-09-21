import {createServer,type Socket} from 'node:net';
import {once} from 'node:events';
import {parser,generate,type Packet} from 'mqtt-packet';
/** Minimal real TCP MQTT 3.1.1 protocol peer, not a production broker. */
export async function mqttPeer({reject=false}:{reject?:boolean}={}){
 const sockets=new Set<Socket>(),packets:Packet[]=[],subscriptions:{topic:string;qos:number}[]=[];
 const server=createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});const decoder=parser();decoder.on('error',()=>socket.destroy());socket.on('data',data=>decoder.parse(data as Buffer));decoder.on('packet',packet=>{packets.push(packet);if(packet.cmd==='connect')socket.write(generate({cmd:'connack',returnCode:0,sessionPresent:false}));else if(packet.cmd==='subscribe'){subscriptions.push(...packet.subscriptions);socket.write(generate({cmd:'suback',messageId:packet.messageId,granted:packet.subscriptions.map(s=>reject?128:s.qos)}));}else if(packet.cmd==='pubrec')socket.write(generate({cmd:'pubrel',messageId:packet.messageId}));else if(packet.cmd==='pingreq')socket.write(generate({cmd:'pingresp'}));});});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {port:(server.address() as {port:number}).port,packets,subscriptions,sockets,publish(topic:string,payload:string,qos:0|1|2=0){for(const socket of sockets)socket.write(generate({cmd:'publish',topic,payload,qos,messageId:12,retain:false,dup:false}));},drop(){for(const socket of sockets)socket.destroy();},async close(){for(const socket of sockets)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}};
}
