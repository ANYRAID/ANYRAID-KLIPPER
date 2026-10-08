import sharp from 'sharp';
import {prepareThumbnailImages,preparePngThumbnailImages} from './thumbnail-images.ts';
sharp.cache(false);sharp.concurrency(1);
let busy=false;
process.on('disconnect',()=>process.exit(0));
process.on('message',async(message:unknown)=>{
 const request=message as {id:number;kind:'blocks'|'png'|'ufp-png';data:string|Buffer};
 if(busy||!request||!Number.isSafeInteger(request.id)||request.id<1)process.exit(1);
 if(request.kind==='blocks'?typeof request.data!=='string'||request.data.length>2*1024**2||Buffer.byteLength(request.data)>2*1024**2:!['png','ufp-png'].includes(request.kind)||!Buffer.isBuffer(request.data)||request.data.length>4*1024**2)process.exit(1);
 busy=true;let response:unknown;
 try{const signal=new AbortController().signal,images=request.kind==='blocks'?await prepareThumbnailImages(request.data as string,signal):await preparePngThumbnailImages(request.data as Buffer,signal,request.kind==='ufp-png'?'lanczos3':'cubic');response={id:request.id,images};}
 catch(error){response={id:request.id,error:error instanceof Error?error.message.slice(0,1024):'Thumbnail processing failed'};}
 busy=false;if(!process.connected)process.exit(0);process.send!(response as object,error=>{if(error)process.exit(1);});
});
process.send!({ready:true},error=>{if(error)process.exit(1);});
