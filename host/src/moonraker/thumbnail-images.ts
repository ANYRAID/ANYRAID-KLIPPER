import sharp from 'sharp';
import qoi from 'qoijs';
import {parseThumbnailBlocks} from './thumbnail-blocks.ts';
export interface ThumbnailImage {width:number;height:number;format:'png'|'jpg';bytes:Buffer;miniature:boolean;}
function qoiPixels(bytes:Buffer){
 if(bytes.length<22||bytes.toString('ascii',0,4)!=='qoif')throw new Error('Invalid QOI header');
 const width=bytes.readUInt32BE(4),height=bytes.readUInt32BE(8),pixels=width*height;
 if(!width||!height||width>2048||height>2048||pixels>4*1024**2)throw new RangeError('QOI dimensions exceed limit');
 const end=bytes.length-8;if(!bytes.subarray(end).equals(Buffer.from([0,0,0,0,0,0,0,1])))throw new Error('Invalid QOI end marker');
 let position=14,emitted=0;while(emitted<pixels){if(position>=end)throw new Error('Truncated QOI');const byte=bytes[position++];position+=byte===254?3:byte===255?4:(byte&192)===128?1:0;emitted+=byte>=192&&byte<254?(byte&63)+1:1;if(position>end||emitted>pixels)throw new Error('Invalid QOI pixel stream');}
 if(position!==end)throw new Error('Trailing QOI pixel data');return qoi.decode(bytes.buffer,bytes.byteOffset,bytes.length);
}
function miniatureSize(width:number,height:number):[number,number]{
 if(width<=32&&height<=32)return [width,height];const aspect=width/height;
 const round=(value:number,key:(n:number)=>number)=>{const floor=Math.floor(value),ceil=Math.ceil(value);return Math.max(key(floor)<=key(ceil)?floor:ceil,1);};
 return aspect<=1?[round(32*aspect,n=>Math.abs(aspect-n/32)),32]:[32,round(32/aspect,n=>n===0?0:Math.abs(aspect-32/n))];
}
/** Pure in-memory image preparation. Publishing filenames and file ownership are
 * deliberately left to the storage owner. Decode outside the print event loop. */
export async function prepareThumbnailImages(data:string,signal:AbortSignal):Promise<ThumbnailImage[]>{
 const blocks=parseThumbnailBlocks(data,signal),images:ThumbnailImage[]=[];let total=0;
 const needsMiniature=!blocks.some(block=>block.width===32&&block.height===32);
 type Pixels={data:Uint8Array;width:number;height:number;channels:1|2|3|4};
 let largest:{image:ThumbnailImage;pixels:Pixels}|undefined;
 for(const block of blocks){
  signal.throwIfAborted();let bytes=block.bytes,pixels:Pixels;const format=block.format==='qoi'?'png':block.format;
  if(block.format==='qoi'){
   const raw=qoiPixels(bytes);if(raw.width!==block.width||raw.height!==block.height)throw new Error('Thumbnail dimensions mismatch');
   pixels={...raw,channels:raw.channels as 3|4};bytes=await sharp(raw.data,{raw:{width:raw.width,height:raw.height,channels:pixels.channels}}).png().toBuffer();
  }else{
   if(format==='png'?!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.length<3||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255)throw new Error('Thumbnail format signature mismatch');
   const decoder=sharp(bytes,{limitInputPixels:4*1024**2,failOn:'warning'}),metadata=await decoder.metadata();signal.throwIfAborted();
   if(metadata.format!==(format==='jpg'?'jpeg':'png')||metadata.width!==block.width||metadata.height!==block.height||metadata.pages&&metadata.pages!==1)throw new Error('Thumbnail format or dimensions mismatch');
   const decoded=await decoder.raw().toBuffer({resolveWithObject:true});
   pixels={data:decoded.data,width:decoded.info.width,height:decoded.info.height,channels:decoded.info.channels};
  }
  signal.throwIfAborted();total+=bytes.length;if(total>8*1024**2)throw new RangeError('Thumbnail output limit exceeded');
  const image:ThumbnailImage={width:block.width,height:block.height,format,bytes,miniature:false};images.push(image);
  // Keep only the current largest candidate's decoded pixels. All other sources
  // are still fully decoded/validated, but never retained for a second decode.
  if(needsMiniature&&(!largest||bytes.length>largest.image.bytes.length))largest={image,pixels};
 }
 if(largest){
  const {image,pixels}=largest,[width,height]=miniatureSize(image.width,image.height);
  const bytes=await sharp(pixels.data,{raw:{width:pixels.width,height:pixels.height,channels:pixels.channels}}).resize(width,height,{fit:'fill',kernel:'cubic',withoutEnlargement:true}).png().toBuffer();signal.throwIfAborted();
  total+=bytes.length;if(total>8*1024**2)throw new RangeError('Thumbnail output limit exceeded');images.unshift({width,height,format:'png',bytes,miniature:true});
 }
 return images;
}
