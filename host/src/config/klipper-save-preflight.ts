import {buildKlipperSave,type SavedConfiguration} from './klipper-save.ts';
import {inspectKlipperConfigurationCandidate,type KlipperFileLimits} from './klipper-files.ts';
import {KlipperConfigText} from './klipper-text.ts';
/** Verifies candidate includes without writing a temporary config. This is not
 * a write lock or durable commit; all source files must be revalidated at save. */
export async function prepareKlipperSave(filename:string,current:string,saved:SavedConfiguration,limits:KlipperFileLimits={}){
 limits.signal?.throwIfAborted();const candidate=buildKlipperSave(current,saved);if(!candidate)return null;
 const wanted=new KlipperConfigText();wanted.append(candidate.autosave);
 const inspected=await inspectKlipperConfigurationCandidate(filename,candidate.text,limits,current),values=wanted.values();
 for(const section of wanted.sections())for(const option of Object.keys(values[section]))if(Object.hasOwn(inspected.regular.original[section]??{},option))throw new Error(`SAVE_CONFIG section '${section}' option '${option}' conflicts with included value`);
 return Object.freeze({...candidate,source:inspected.source});
}
