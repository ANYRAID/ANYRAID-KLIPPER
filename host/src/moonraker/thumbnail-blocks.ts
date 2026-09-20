import unicode from '../../contracts/unicode-thumbnail-15.json' with {type:'json'};
export interface ThumbnailBlock {width:number;height:number;format:'png'|'jpg'|'qoi';bytes:Buffer;}
const ranges=unicode.wordOrSpace.map(([a,b])=>`\\u{${a.toString(16)}}${a===b?'':`-\\u{${b.toString(16)}}`}`).join('');
const prefix=/(thumbnail(?:_[A-Za-z0-9]+)?) begin/gu;
const validBody=new RegExp(`^[;/+=${ranges}]+$`,'u');
/** CPython non-strict base64: ignore foreign characters, require valid padding,
 * and ignore everything after a completed padded quantum. */
export function decodeThumbnailBase64(value:string):Buffer{
 const chars=value.replace(/[^A-Za-z0-9+/=]/g,'');let count=0,padding=false,end=chars.length;
 for(let i=0;i<chars.length;i++){
  if(chars[i]==='='){if(count===3||count===2&&padding){end=i+1;count=0;break;}if(count===2)padding=true;}
  else{count=(count+1)%4;padding=false;}
 }
 if(count!==0)throw new Error('Invalid thumbnail base64 padding');
 return Buffer.from(chars.slice(0,end).replaceAll('=',''),'base64');
}
/** Extract original text envelopes; image validity is checked by the decoder. */
export function parseThumbnailBlocks(data:string,signal:Pick<AbortSignal,'throwIfAborted'>):ThumbnailBlock[]{
 if(Buffer.byteLength(data)>2*1024**2)throw new RangeError('Thumbnail text limit exceeded');
 const result:ThumbnailBlock[]=[];let matches=0,total=0;prefix.lastIndex=0;
 let match:RegExpExecArray|null;while((match=prefix.exec(data))!==null){
  signal.throwIfAborted();if(++matches>64)throw new RangeError('Thumbnail block count limit exceeded');
  const marker=`; ${match[1]} end`,end=data.indexOf(marker,prefix.lastIndex);if(end<0)continue;
  const body=data.slice(prefix.lastIndex,end);if(!validBody.test(body))continue;prefix.lastIndex=end+marker.length;
  const format=(match[1].split('_')[1]??'png').toLowerCase();if(format!=='png'&&format!=='jpg'&&format!=='qoi')continue;
  const lines=body.replaceAll('; ','').split(/\r?\n/u),info=Array.from(lines[0].matchAll(/[0-9]+/g),m=>Number(m[0])),encoded=lines.slice(1,-1).join('');
  let length=0;for(const _ of encoded)length++;
  if(info.length!==3||length!==info[2])continue;
  const [width,height]=info;if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>2048||height>2048||width*height>4*1024**2)throw new RangeError('Thumbnail dimensions exceed limit');
  if(encoded.length>2*1024**2)throw new RangeError('Thumbnail encoded bytes exceed limit');
  const bytes=decodeThumbnailBase64(encoded);total+=bytes.length;if(total>2*1024**2)throw new RangeError('Thumbnail decoded bytes exceed limit');
  result.push({width,height,format,bytes});
 }
 signal.throwIfAborted();return result;
}
