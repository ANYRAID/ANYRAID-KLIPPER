import type {MetadataWindow} from './metadata-window.ts';
import {identifySlicer,type SlicerFamily} from './slicer-identification.ts';
import {parseUnknownMetadata} from './metadata-common.ts';
import {parsePrusaMetadata} from './metadata-prusa.ts';
import {parseOtherMetadata} from './metadata-other.ts';
/** Scalar/list extraction only. No thumbnail generation, UUID, processors or persistence. */
type FieldWindow=Pick<MetadataWindow,'identificationHeader'|'header'|'footer'|'size'|'modified'>;
type ExtractedFields=Record<string,number|string|number[]|string[]> & {size:number;modified:number;slicer:string;slicer_version:string};
export function extractSlicerFields(window:FieldWindow):ExtractedFields{return inspectSlicerFields(window).fields;}
export function inspectSlicerFields(window:FieldWindow){
 const identity=identifySlicer(window.identificationHeader);let fields:Record<string,number|string|number[]|string[]>;
 switch(identity.family){
  case 'UnknownSlicer':fields=parseUnknownMetadata(window);break;
  case 'PrusaSlicer':case 'Slic3rPE':case 'Slic3r':case 'BambuStudio':fields=parsePrusaMetadata(window,identity.family);break;
  default:fields=parseOtherMetadata(window,identity.family,identity.version);
 }
 const metadata:ExtractedFields={size:window.size,modified:window.modified,slicer:identity.name,slicer_version:identity.version,...fields};
 return {fields:metadata,identity,objects:detectSlicerObjects(window.header,identity.family)};
}
/** Original detection only; does not rewrite or enable object cancellation. */
export function detectSlicerObjects(header:string,family:SlicerFamily):{hasObjects:boolean;hasM486Objects:boolean}{
 if(/\n(?:DEFINE_OBJECT|EXCLUDE_OBJECT_DEFINE) NAME=/u.test(header))return {hasObjects:false,hasM486Objects:false};
 if(/\nM486/u.test(header))return {hasObjects:true,hasM486Objects:true};
 const marker=['PrusaSlicer','Slic3rPE','Slic3r','BambuStudio'].includes(family)?'\n; printing object':family==='Cura'?'\n;MESH:':family==='IdeaMaker'?'\n;PRINTING:':undefined;
 return {hasObjects:marker!==undefined&&header.includes(marker),hasM486Objects:false};
}
