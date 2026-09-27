import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {SkewCorrection,type SkewFactors} from '../motion/skew.ts';
/** Stored profiles do not activate themselves at startup. */
export function readSkewProfiles(reader:ConfigurationReader):Readonly<Record<string,Readonly<SkewFactors>>>|undefined{
 const profiles=reader.sections().filter(s=>s.startsWith('skew_correction '));
 if(!reader.hasSection('skew_correction')){if(profiles.length)throw new Error('Skew profiles require skew_correction');return;}
 if(Object.keys(reader.section('skew_correction').options()).length)throw new Error('skew_correction does not accept options');
 const result:Record<string,Readonly<SkewFactors>>=Object.create(null);
 for(const section of profiles){const name=section.slice(16),s=reader.section(section);
  if(!name.trim()||name!==name.trim()||name.length>128||/[\x00-\x1f\x7f]/.test(name))throw new Error('Invalid skew profile name');
  if(Object.keys(s.options()).some(k=>!['xy_skew','xz_skew','yz_skew'].includes(k)))throw new Error('Unknown skew profile option');
  result[name]=new SkewCorrection({xy:s.getFloat('xy_skew'),xz:s.getFloat('xz_skew'),yz:s.getFloat('yz_skew')}).factors;
 }
 return Object.freeze(result);
}
