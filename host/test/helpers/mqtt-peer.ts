import {createServer,type Socket} from 'node:net';
import {createServer as createTlsServer} from 'node:tls';
import {once} from 'node:events';
import {parser,generate,type Packet} from 'mqtt-packet';
/** Minimal TCP MQTT protocol peer. Negotiates framing from CONNECT; not a broker. */
export async function mqttPeer({reject=false,rejectConnection=false,tls}:{reject?:boolean;rejectConnection?:boolean;tls?:{key:string;cert:string}}={}){
 const sockets=new Set<Socket>(),packets:Packet[]=[],subscriptions:{topic:string;qos:number}[]=[],versions=new Map<Socket,3|4|5>();
 const connections=new Set<Socket>();
 const send=(socket:Socket,packet:Packet)=>socket.write(generate(packet,{protocolVersion:versions.get(socket)??4}));
 const accept=(socket:Socket)=>{
  sockets.add(socket);socket.on('close',()=>{sockets.delete(socket);versions.delete(socket);});socket.on('error',()=>{});
  const decoder=parser();decoder.on('error',()=>socket.destroy());socket.on('data',data=>decoder.parse(data as Buffer));
  decoder.on('packet',packet=>{
   packets.push(packet);
   if(packet.cmd==='connect'){
    versions.set(socket,packet.protocolVersion as 3|4|5);
    send(socket,{cmd:'connack',returnCode:rejectConnection?5:0,reasonCode:rejectConnection?135:0,sessionPresent:false});
   }else if(packet.cmd==='subscribe'){
    subscriptions.push(...packet.subscriptions);send(socket,{cmd:'suback',messageId:packet.messageId,granted:packet.subscriptions.map(s=>reject?128:s.qos)});
   }else if(packet.cmd==='pubrec')send(socket,{cmd:'pubrel',messageId:packet.messageId});
   else if(packet.cmd==='pingreq')send(socket,{cmd:'pingresp'});
  });
 };
 const server=tls?createTlsServer(tls,accept):createServer(accept);server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));});server.on('tlsClientError',()=>{});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {port:(server.address() as {port:number}).port,packets,subscriptions,sockets,
  send(packet:Packet){for(const socket of sockets)send(socket,packet);},
  publish(topic:string,payload:string,qos:0|1|2=0){for(const socket of sockets)send(socket,{cmd:'publish',topic,payload,qos,messageId:12,retain:false,dup:false});},
  drop(){for(const socket of connections)socket.destroy();},
  async close(){for(const socket of connections)socket.destroy();await new Promise<void>(r=>server.close(()=>r()));}
 };
}
