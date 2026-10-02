import {markerData} from './marker-data.ts';
interface Geometry {vertices:number[][];codes:number[];}
interface Marker {main:Geometry;alt:Geometry|null;filled:boolean;join:string;cap:string;}
const data=markerData as Record<string,Record<string,Marker>>;
export const motanMarkers=Object.freeze(['none','None','',' ',...Object.keys(data)]);
export const motanFillStyles=Object.freeze(['full','left','right','bottom','top','none']);
export function markerPath(geometry:Geometry,size:number):string{
 let d='';for(let i=0;i<geometry.codes.length;i++){
  const code=geometry.codes[i];if(code===79){d+='Z';continue;}
  const count=code===4?3:code===3?2:1,command=code===1?'M':code===2?'L':code===3?'Q':code===4?'C':undefined;
  if(!command)throw new Error('Invalid marker path code');d+=command;
  for(let j=0;j<count;j++,i++){const [x,y]=geometry.vertices[i];d+=(j?' ':'')+(x*size)+','+(-y*size);}i--;
 }return d;
}
/** Convert fixed upstream geometry once per series, never once per sample. */
export function prepareMotanMarker(marker:string,fillstyle:string,size:number,edgeWidth:number,id:string){
 if(!motanMarkers.includes(marker)||!motanFillStyles.includes(fillstyle))throw new Error('Unsupported plot marker or fill style');
 if(!Number.isFinite(size)||size<0||size>40||!Number.isFinite(edgeWidth)||edgeWidth<0||edgeWidth>20)throw new Error('Invalid marker size or edge width');
 if(!Object.hasOwn(data,marker)||size===0&&marker!==',')return {definitions:'',draw:(_x:number,_y:number,_face:string,_edge:string,_alternate:string)=>''};
 const item=data[marker][fillstyle],scale=marker===','?1:size,main=markerPath(item.main,scale),alt=item.alt?markerPath(item.alt,scale):undefined;
 const definitions=`<path id="${id}-main" d="${main}"/>`+(alt?`<path id="${id}-alt" d="${alt}"/>`:'');
 return {definitions,draw:(x:number,y:number,face:string,edge:string,alternate:string)=>{
  const attributes=`data-marker="${marker.replaceAll('<','&lt;').replaceAll('>','&gt;')}" x="${x}" y="${y}" stroke="${edge}" stroke-width="${marker===','?0:edgeWidth}" stroke-linejoin="${item.join}" stroke-linecap="${item.cap==='projecting'?'square':item.cap}"`;
  return `<use ${attributes} href="#${id}-main" fill="${item.filled?face:'none'}"/>`+(alt?`<use ${attributes} href="#${id}-alt" fill="${alternate}"/>`:'');
 }};
}
