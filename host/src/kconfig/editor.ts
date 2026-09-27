import {KconfigModel} from './model.ts';
import {loadKconfigConfiguration,kconfigFull,kconfigMinimal} from './configuration.ts';
import type {KTree,KNode} from './parser.ts';

export interface KMenuItem{
 node:KNode;
 label:string;
 name?:string;
 value?:string;
 visible:boolean;
 kind:KNode['kind'];
}
/** In-memory editor; no file writes or hardware side effects.
 * User preferences survive temporary invisibility and architecture changes. */
export class KconfigEditor{
 readonly tree:KTree;
 readonly prefix:string;
 readonly header:string;
 private model:KconfigModel;
 private assignments:Map<string,string>;
 private selections:Map<string,string>;
 private savedContent:string;
 private readonly parents=new Map<KNode,KNode>();
 warnings:readonly string[];
 constructor(tree:KTree,source='',prefix='CONFIG_',header=''){
  this.tree=tree;this.prefix=prefix;this.header=header;
  const loaded=loadKconfigConfiguration(tree,source,prefix);
  loaded.model.resolve();
  this.model=loaded.model;this.assignments=loaded.assignments;this.selections=loaded.selections;this.warnings=loaded.warnings;this.savedContent=source;
  const walk=(node:KNode)=>{for(const child of node.children){this.parents.set(child,node);walk(child);}};walk(tree.root);
 }
 get dirty():boolean{return this.full()!==this.savedContent;}
 full():string{return kconfigFull(this.tree,this.model,this.header,this.prefix);}
 minimal():string{return kconfigMinimal(this.model,this.header,this.prefix);}
 value(name:string):string{return this.model.value(name).text;}
 /** Call only after the exact full contents were successfully saved. */
 markSaved(contents:string):void{
  if(contents!==this.full())throw new Error('Saved configuration does not match current editor state');
  this.savedContent=contents;
 }
 load(source:string):void{
  const next=loadKconfigConfiguration(this.tree,source,this.prefix);next.model.resolve();
  this.model=next.model;this.assignments=next.assignments;this.selections=next.selections;this.warnings=next.warnings;this.savedContent=source;
 }
 reset():void{
  const model=new KconfigModel(this.tree);model.resolve();
  this.model=model;this.assignments=new Map();this.selections=new Map();this.warnings=[];
 }
 set(name:string,value:string):void{
  const symbol=this.model.symbols.get(name);
  if(!symbol)throw new Error('Unknown Kconfig symbol: '+name);
  if(!this.model.value(name).visibility)throw new Error('Symbol is not currently visible: '+name);
  const assignments=new Map(this.assignments),selections=new Map(this.selections);
  assignments.delete(name);assignments.set(name,value);
  if(symbol.choice&&value==='y')selections.set(symbol.choice.id,name);
  const next=new KconfigModel(this.tree,assignments,selections);next.resolve();
  if(next.value(name).text!==value)throw new Error('Value is constrained by dependencies, selections or range: '+name);
  this.model=next;this.assignments=assignments;this.selections=selections;
 }
 parent(node:KNode):KNode|undefined{
  let parent=this.parents.get(node);
  while(parent?.kind==='if')parent=this.parents.get(parent);
  return parent;
 }
 path(node:KNode):string[]{
  const result:string[]=[];let current:KNode|undefined=node;
  while(current){if(current.kind!=='if')result.unshift(this.item(current).label);current=this.parents.get(current);}
  return result;
 }
 item(node:KNode):KMenuItem{
  const prompt=node.properties.find(p=>p.kind==='prompt');
  const symbol=node.kind==='config'||node.kind==='menuconfig';
  return {node,kind:node.kind,name:node.name,label:prompt?.kind==='prompt'?prompt.text:node.title??node.name??(node.kind==='choice'?'Choice':node.kind),visible:symbol||node.kind==='choice'?this.model.promptVisible(node):this.model.nodeVisible(node),value:symbol?this.model.value(node.name!).text:undefined};
 }
 items(parent=this.tree.root,showAll=false):KMenuItem[]{
  const items:KMenuItem[]=[];
  const visit=(node:KNode)=>{
   if(node.kind==='if'){node.children.forEach(visit);return;}
   const item=this.item(node);if(showAll||item.visible)items.push(item);
  };
  parent.children.forEach(visit);return items;
 }
 search(query:string,showAll=false):KMenuItem[]{
  const text=query.trim().toLowerCase();if(!text)return [];
  const items:KMenuItem[]=[];
  const visit=(node:KNode)=>{
   if(node.kind!=='root'&&node.kind!=='if'){
    const item=this.item(node);
    if((showAll||item.visible)&&(item.name?.toLowerCase().includes(text)||item.label.toLowerCase().includes(text)))items.push(item);
   }
   node.children.forEach(visit);
  };
  visit(this.tree.root);return items;
 }
 help(node:KNode):string{
  const item=this.item(node);
  return [this.path(node).join(' / '),node.file+':'+node.line,...(item.name?['Symbol: '+item.name]:[]),...(item.value!==undefined?['Value: '+item.value]:[]),item.visible?'Visible':'Hidden by dependencies',node.help??'No help available.'].join('\n');
 }
}
