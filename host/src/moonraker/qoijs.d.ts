declare module 'qoijs' {
 const qoi:{decode(buffer:ArrayBufferLike,offset:number,length:number,channels?:number):{width:number;height:number;channels:number;data:Uint8Array;colorspace:number};encode(data:Uint8Array,description:{width:number;height:number;channels:number;colorspace:number}):ArrayBuffer};
 export default qoi;
}
