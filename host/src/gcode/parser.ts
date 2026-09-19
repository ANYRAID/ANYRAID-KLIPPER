// Port of klippy/gcode.py parsing rules; GPL-3.0-or-later.
// Original Copyright (C) 2016-2025 Kevin O'Connor.
export interface ParsedCommand {
  command:string;
  commandline:string;
  params:Record<string,string>;
}
/** Traditional parsing is also the first pass for registered extended commands. */
export function parseCommand(input:string):ParsedCommand {
  if(input.length>65536||/[\r\n\0]/.test(input))throw new RangeError('Invalid G-code line');
  const commandline=input.trim(),line=commandline.split(';',1)[0];
  const parts=line.toUpperCase().split(/([A-Z_]+|[A-Z*])/);
  const command=(parts.slice(0,2).join('')==='N'?parts.slice(3,5):parts.slice(0,3)).join('').trim();
  // No prototype: parameter names must never affect object inheritance.
  const params:Record<string,string>=Object.create(null);
  for(let i=1;i<parts.length;i+=2)params[parts[i]]=parts[i+1].trim();
  return {command,commandline,params};
}
export function rawParameters(parsed:ParsedCommand):string {
  const {command,commandline}=parsed;let start=command.length,end=commandline.length;
  if(commandline.slice(0,start).toUpperCase()!==command) {
    start+=commandline.toUpperCase().indexOf(command);
    const star=commandline.lastIndexOf('*');
    if(star>=0&&/^\d+$/.test(commandline.slice(star+1)))end=star;
  }
  if(/\s/.test(commandline.slice(start,start+1)))start++;
  return commandline.slice(start,end);
}
/** POSIX shlex with whitespace_split and '#;' comments, as used by Klipper. */
function shellWords(raw:string):string[] {
  const words:string[]=[];let word='',active=false,quote='';
  for(let i=0;i<raw.length;i++) {
    const c=raw[i];
    if(quote==="'") {if(c==="'")quote='';else word+=c;continue;}
    if(c==='\\') {
      if(++i===raw.length)throw new SyntaxError('No escaped character');
      const next=raw[i];
      // Python shlex only removes escapes for double quote and backslash in "".
      if(quote==='"'&&next!=='"'&&next!=='\\')word+='\\';
      word+=next;active=true;continue;
    }
    if(quote==='"') {if(c==='"')quote='';else word+=c;continue;}
    if(c==='"'||c==="'"){quote=c;active=true;continue;}
    if(c==='#'||c===';')break;
    if(' \t\r\n'.includes(c)) {
      if(active){words.push(word);word='';active=false;}continue;
    }
    word+=c;active=true;
  }
  if(quote)throw new SyntaxError('No closing quotation');
  if(active)words.push(word);return words;
}
/** Call only after resolving a registered extended handler (not M117/M118). */
export function extendedParameters(parsed:ParsedCommand):Record<string,string> {
  const params:Record<string,string>=Object.create(null);
  for(const word of shellWords(rawParameters(parsed))) {
    const equal=word.indexOf('=');if(equal<0)throw new SyntaxError('Malformed extended command');
    params[word.slice(0,equal).toUpperCase()]=word.slice(equal+1);
  }
  return params;
}
