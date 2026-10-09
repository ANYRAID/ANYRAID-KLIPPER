// RSS wire semantics follow Moonraker announcements.py at the pinned contract.
// Copyright (C) 2022 Eric Callahan; GPL-3.0-or-later.
import {SaxesParser} from 'saxes';
export interface AnnouncementItem {
 entry_id:string;url:string|null;title:string|null;description:string|null;
 priority:string|null;date:number;
}
export interface AnnouncementFeed {prefix:string;items:AnnouncementItem[];}
interface Element {name:string;text:string|null;children:Element[];}
/** Called in a bounded worker, never on the printer's event loop. No DTD,
 * external entities, network or executable HTML. Namespace URIs match the
 * pinned ElementTree expanded names; they never select a resource to load. */
export function parseAnnouncementFeed(xml:string,now:number):AnnouncementFeed|null {
 if(Buffer.byteLength(xml)>1048576||!Number.isFinite(now))throw Error('Invalid announcement RSS input');
 const parser=new SaxesParser({xmlns:true}),stack:Element[]=[];let root:Element|undefined,nodes=0;
 parser.on('doctype',()=>{throw Error('Announcement DTD is forbidden');});
 parser.on('error',()=>{throw Error('Invalid announcement XML');});
 parser.on('opentag',tag=>{
  if(++nodes>8192||stack.length>=32)throw Error('Announcement XML capacity exceeded');
  const element:Element={name:tag.uri?'{'+tag.uri+'}'+tag.local:tag.local,text:null,children:[]};
  if(stack.length)stack.at(-1)!.children.push(element);else root=element;stack.push(element);
 });
 const text=(value:string)=>{const current=stack.at(-1);if(current&&current.children.length===0)current.text=(current.text??'')+value;};
 parser.on('text',text);parser.on('cdata',text);parser.on('closetag',()=>{stack.pop();});parser.write(xml).close();
 const channel=root?.children.find(child=>child.name==='channel');if(!channel)return null;
 const get=(element:Element,name:string)=>{const found=element.children.find(child=>child.name===name);return found?found.text??'':null;};
 let prefix=(get(channel,'title')??'').toLowerCase();const items:AnnouncementItem[]=[];
 for(const item of channel.children.filter(child=>child.name==='item')){
  const id=get(item,'guid');if(!id)continue;
  if(items.length>=256)throw Error('Announcement item capacity exceeded');
  if(!prefix)prefix=id.split('/').slice(0,2).join('/');
  const timestamp=Date.parse(get(item,'pubDate')??'');
  items.push({entry_id:id,url:get(item,'link'),title:get(item,'title'),description:get(item,'description'),priority:get(item,'category'),date:Number.isFinite(timestamp)?timestamp/1000:now});
 }
 return {prefix,items};
}
