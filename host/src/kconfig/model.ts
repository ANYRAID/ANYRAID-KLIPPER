import {kconfigYes,type KExpression} from './expression.ts';
import {evaluateKconfig,kconfigAtom,kconfigInteger,type KValue,type KValueType,type KTristate} from './evaluate.ts';
import type {KTree,KNode,KProperty} from './parser.ts';
type Definition={node:KNode;dependency:KExpression;promptDependency:KExpression};
type SymbolDefinition={name:string;type:KValueType;definitions:Definition[];choice?:Choice};
type Choice={id:string;definition:Definition;members:string[]};
export interface KResolved extends KValue{visibility:KTristate;write:boolean;}
const and=(left:KExpression,right:KExpression):KExpression=>({kind:'binary',operator:'&&',left,right});
const atom=(value:string):KExpression=>({kind:'symbol',value});
const yes=kconfigYes;

/** Immutable evaluation session: rebuild after user assignments change.
 * All project types are supported; tristate declarations fail explicitly until
 * module-mode choice resolution is implemented. No iterative best-effort values. */
export class KconfigModel {
 readonly symbols=new Map<string,SymbolDefinition>();
 private readonly choices=new Map<string,Choice>();
 private readonly reverse=new Map<string,{source:string;condition:KExpression;weak:boolean}[]>();
 private readonly cache=new Map<string,KResolved>();
 private readonly memo=new Map<string,number|string|undefined>();
 private readonly active=new Set<string>();
 private readonly users:Map<string,string>;
 constructor(tree:KTree,assignments:ReadonlyMap<string,string>=new Map()){
  this.users=new Map(assignments);
  const visit=(node:KNode,parent:KExpression,visible:KExpression,choice?:Choice)=>{
   let dependency=parent,promptDependency=visible;
   for(const property of node.properties){
    if(property.kind==='depends')dependency=and(dependency,property.expression);
    if(property.kind==='visible')promptDependency=and(promptDependency,property.expression);
   }
   const definition={node,dependency,promptDependency};
   if(node.kind==='choice'){
    if(node.properties.some(p=>p.kind==='type'&&p.type==='tristate'))throw new Error('Tristate choices not yet supported');
    choice={id:'@choice:'+node.file+':'+node.line,definition,members:[]};
    this.choices.set(choice.id,choice);dependency=and(dependency,atom(choice.id));
   }
   if(node.kind==='config'||node.kind==='menuconfig'){
    const name=node.name!;
    let symbol=this.symbols.get(name);
    if(!symbol){symbol={name,type:'unknown',definitions:[],choice};this.symbols.set(name,symbol);}
    if(choice&&!choice.members.includes(name))choice.members.push(name);
    for(const property of node.properties)if(property.kind==='type'){
     if(property.type==='tristate')throw new Error('Tristate symbols not yet supported: '+name);
     if(symbol.type!=='unknown'&&symbol.type!==property.type)throw new Error('Conflicting Kconfig types: '+name);
     symbol.type=property.type;
    }
    symbol.definitions.push(definition);
    for(const property of node.properties)if(property.kind==='select'||property.kind==='imply'){
     const rows=this.reverse.get(property.name)??[];
     rows.push({source:name,condition:and(dependency,property.condition),weak:property.kind==='imply'});
     this.reverse.set(property.name,rows);
    }
   }
   for(const child of node.children)visit(child,dependency,promptDependency,choice);
  };
  visit(tree.root,yes,yes);
  for(const [name,text] of this.users){
   const symbol=this.symbols.get(name);if(!symbol)throw new Error('Unknown Kconfig assignment: '+name);
   if(symbol.type==='bool'&&!['n','y'].includes(text))throw new Error('Invalid bool assignment: '+name);
   if(symbol.type==='unknown')throw new Error('Untyped Kconfig assignment: '+name);
   if(symbol.type==='int'||symbol.type==='hex'){
    const value=kconfigInteger(text,symbol.type==='int'?10:16);
    if(value===undefined||(symbol.type==='hex'&&value<0n))throw new Error('Invalid numeric assignment: '+name);
   }
  }
 }
 private guarded<T>(key:string,run:()=>T):T{
  if(this.active.has(key))throw new Error('Kconfig dependency cycle: '+[...this.active,key].join(' -> '));
  this.active.add(key);try{return run();}finally{this.active.delete(key);}
 }
 private lookup=(name:string):KValue|undefined=>{
  const choice=this.choices.get(name);
  if(choice){const tri=this.choiceMode(choice);return {type:'bool',text:tri?'y':'n',tri};}
  return this.symbols.has(name)?this.value(name):undefined;
 };
 private evaluate=(expression:KExpression)=>evaluateKconfig(expression,this.lookup);
 private properties(symbol:SymbolDefinition):{property:KProperty;condition:KExpression}[]{
  return symbol.definitions.flatMap(definition=>definition.node.properties.map(property=>({property,condition:and(definition.dependency,'condition' in property?property.condition:yes)})));
 }
 private visibility(definitions:Definition[]):KTristate{
  let value=0;
  for(const definition of definitions)for(const property of definition.node.properties)if(property.kind==='prompt')value=Math.max(value,this.evaluate(and(and(definition.dependency,definition.promptDependency),property.condition)));
  return value?2:0;
 }
 private choiceMode(choice:Choice):KTristate{
  const key=choice.id+':mode';if(this.memo.has(key))return this.memo.get(key) as KTristate;
  return this.guarded(key,()=>{
   const optional=choice.definition.node.properties.some(p=>p.kind==='optional');
   const selected=choice.members.some(name=>this.users.get(name)==='y');
   const mode=(!optional||selected)?this.visibility([choice.definition]):0;
   this.memo.set(key,mode);return mode;
  });
 }
 private selection(choice:Choice):string|undefined{
  const key=choice.id+':selection';if(this.memo.has(key))return this.memo.get(key) as string|undefined;
  return this.guarded(key,()=>{
   let selected:string|undefined;
   const visible=(name:string)=>this.visibility(this.symbols.get(name)!.definitions)>0;
   if(this.choiceMode(choice)){
    // Last y assignment is the user selection, including when several members are set.
    for(const [name,value] of this.users)if(value==='y'&&choice.members.includes(name))selected=name;
    if(selected&&!visible(selected))selected=undefined;
    if(!selected)for(const property of choice.definition.node.properties)if(property.kind==='default'&&this.evaluate(and(choice.definition.dependency,property.condition))){
     if(property.value.kind==='symbol'&&choice.members.includes(property.value.value)&&visible(property.value.value)){selected=property.value.value;break;}
    }
    selected??=choice.members.find(visible);
   }
   this.memo.set(key,selected);return selected;
  });
 }
 value(name:string):KResolved{
  const cached=this.cache.get(name);if(cached)return cached;
  return this.guarded(name,()=>{
   const symbol=this.symbols.get(name);if(!symbol)throw new Error('Unknown Kconfig symbol: '+name);
   const visibility=this.visibility(symbol.definitions),properties=this.properties(symbol),user=this.users.get(name);
   let text='',tri:KTristate=0,write=visibility>0;
   if(symbol.type==='unknown')text=name;
   else if(symbol.type==='bool'){
    if(symbol.choice)tri=visibility&&this.selection(symbol.choice)===name?2:0;
    else{
     if(visibility&&user!==undefined)tri=user==='y'?2:0;
     else{
      for(const {property,condition} of properties)if(property.kind==='default'){
       const dep=this.evaluate(condition);if(dep){tri=Math.min(dep,this.evaluate(property.value)) as KTristate;write ||=tri>0;break;}
      }
      for(const reverse of this.reverse.get(name)??[])if(reverse.weak&&symbol.definitions.some(d=>this.evaluate(d.dependency))){const value=this.evaluate(and(atom(reverse.source),reverse.condition));tri=Math.max(tri,value) as KTristate;write ||=value>0;}
     }
     for(const reverse of this.reverse.get(name)??[])if(!reverse.weak){const value=this.evaluate(and(atom(reverse.source),reverse.condition));tri=Math.max(tri,value) as KTristate;write ||=value>0;}
     if(tri===1)tri=2;
    }
    text=tri?'y':'n';
   }else{
    const base=symbol.type==='hex'?16:10;
    let range:{low:bigint;high:bigint}|undefined;
    if(symbol.type==='int'||symbol.type==='hex')for(const {property,condition} of properties)if(property.kind==='range'&&this.evaluate(condition)){
     range={low:kconfigInteger(kconfigAtom(property.minimum,this.lookup).text,base)??0n,high:kconfigInteger(kconfigAtom(property.maximum,this.lookup).text,base)??0n};break;
    }
    const number=user===undefined?undefined:kconfigInteger(user,base);
    if(visibility&&user!==undefined&&(!range||(number!==undefined&&number>=range.low&&number<=range.high)))text=user;
    else{
     for(const {property,condition} of properties)if(property.kind==='default'&&this.evaluate(condition)){text=kconfigAtom(property.value,this.lookup).text;write=true;break;}
     if(range){const value=kconfigInteger(text,base)??0n;const clamped=value<range.low?range.low:value>range.high?range.high:value;if(value!==clamped)text=base===10?String(clamped):(clamped<0n?'-0x'+(-clamped).toString(16):'0x'+clamped.toString(16));}
    }
   }
   const result={type:symbol.type,text,tri,visibility,write};this.cache.set(name,result);return result;
  });
 }
 resolve():Record<string,KResolved>{return Object.fromEntries([...this.symbols.keys()].map(name=>[name,this.value(name)]));}
}
