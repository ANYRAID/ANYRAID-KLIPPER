import {BedMesh,type BedMeshParameters} from './bed-mesh.ts';
import {BedMeshProfiles} from './bed-mesh-profiles.ts';
import {bedMeshProfileChanges} from './bed-mesh-save.ts';
import {KlipperSaveSession} from '../config/klipper-save-session.ts';
/** Session profiles and pending configuration move together. File persistence
 * still requires SAVE_CONFIG; loading here does not activate a motion transform. */
export class BedMeshProfileStore {
 #meshes=new Map<string,BedMesh>();#incompatible=new Map<string,number>();readonly #session:KlipperSaveSession;
 constructor(profiles:BedMeshProfiles,session:KlipperSaveSession){this.#session=session;for(const name of profiles.names)this.#meshes.set(name,profiles.load(name));for(const p of profiles.incompatible)this.#incompatible.set(p.name,p.version);}
 get names():readonly string[]{return [...this.#meshes.keys()];}
 get incompatible(){return [...this.#incompatible].map(([name,version])=>({name,version}));}
 get status():Record<string,{points:number[][];mesh_params:BedMeshParameters}>{const out:Record<string,{points:number[][];mesh_params:BedMeshParameters}>=Object.create(null);for(const [name,m] of this.#meshes){const p=m.params,v=m.probedValues();out[name]={points:Array.from({length:p.y_count},(_,y)=>Array.from(v.subarray(y*p.x_count,(y+1)*p.x_count))),mesh_params:{...p}};}return out;}
 load(name:string):BedMesh{const mesh=this.#meshes.get(name);if(!mesh)throw new Error(`Unknown bed mesh profile: ${name}`);return mesh.copy();}
 save(name:string,mesh:BedMesh):void{
  const changes=bedMeshProfileChanges(name,mesh);
  if(!this.#meshes.has(name)&&!this.#incompatible.has(name)&&this.#meshes.size+this.#incompatible.size>=128)throw new RangeError('Bed mesh profile count exceeds limit');
  let cells=mesh.width*mesh.height;for(const [key,m] of this.#meshes)if(key!==name)cells+=m.width*m.height;if(cells>2000000)throw new RangeError('Stored bed mesh grid budget exceeded');
  // Upstream profiles store probe data, not live XY offsets or mesh buffers.
  const p=mesh.params,v=mesh.probedValues(),snapshot=new BedMesh(p,Array.from({length:p.y_count},(_,y)=>Array.from(v.subarray(y*p.x_count,(y+1)*p.x_count))));
  const next=new Map(this.#meshes);next.set(name,snapshot);const incompatible=new Map(this.#incompatible);incompatible.delete(name);
  this.#session.apply(changes);this.#meshes=next;this.#incompatible=incompatible;
 }
 remove(name:string):boolean{if(!this.#meshes.has(name))return false;const next=new Map(this.#meshes);next.delete(name);this.#session.apply([{kind:'remove',section:'bed_mesh '+name}]);this.#meshes=next;return true;}
}
