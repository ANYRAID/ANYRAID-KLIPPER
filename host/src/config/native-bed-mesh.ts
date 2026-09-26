import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {BedMeshProfiles} from '../motion/bed-mesh-profiles.ts';
import {BedMeshFade} from '../motion/bed-mesh-fade.ts';
/** Saved profiles are opt-in; never silently load default or invent probe data. */
export function readNativeBedMesh(reader:ConfigurationReader){
 if(!reader.hasSection('bed_mesh'))return undefined;
 const section=reader.section('bed_mesh'),fadeConfig={start:section.getFloat('fade_start',{defaultValue:1}),end:section.getFloat('fade_end',{defaultValue:0}),target:section.getFloat('fade_target',{defaultValue:null})};
 BedMeshFade.forMesh(null,fadeConfig);
 return {profiles:new BedMeshProfiles(reader),settings:{fadeConfig,splitDeltaZ:section.getFloat('split_delta_z',{defaultValue:.025,minval:.01}),checkDistance:section.getFloat('move_check_distance',{defaultValue:5,minval:3})}};
}
export type NativeBedMeshConfiguration=NonNullable<ReturnType<typeof readNativeBedMesh>>;
