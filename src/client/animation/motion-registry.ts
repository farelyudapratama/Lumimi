/**
 * animation/motion-registry.ts — Central registry for all motion sources.
 * Parity with js/motion-registry.js (createRegistry).
 */
import type { MotionAsset } from "../../shared/types";
import type { NativeClip } from "../engine/native-clips";
import { stepsToTracks, summaryForLLM } from "./motion-dsl";

export interface RegistryEntry extends MotionAsset {
  source: "builtin" | "native" | "user";
  /** Data playback klip native — diisi registerNativeClips; runtime
   * meneruskannya ke bridge.playNative (grup + index exact). loop = klip
   * Meta.Loop, tidak pernah selesai sendiri di framework. */
  native?: { group: string; index: number; loop?: boolean };
  /** Path file klip native (relatif folder model3.json) — dipakai Motion
   * Studio untuk impor/preview isi klip. */
  file?: string;
}

export class MotionRegistry {
  private byId = new Map<string, RegistryEntry>();
  private cooldownUntil = new Map<string, number>();

  register(asset: RegistryEntry, opts?: { overwrite?: boolean }): { ok: boolean; error?: string } {
    if (!asset || typeof asset !== "object" || !(asset as any).id) return { ok: false, error: "asset kosong / tanpa id" };
    const prev = this.byId.get((asset as any).id);
    if (prev && !(opts && opts.overwrite)) {
      if (prev.source !== asset.source) return { ok: false, error: `id "${(asset as any).id}" sudah dipakai entri ${prev.source} ("${(prev as any).name}")` };
    }
    this.byId.set((asset as any).id, { ...asset });
    return { ok: true };
  }

  get(id: string): RegistryEntry | null { const a=this.byId.get(id); return a?{...a}:null; }
  has(id: string): boolean { return this.byId.has(id); }
  remove(id: string, source?: string): boolean {
    const a=this.byId.get(id); if(!a) return false; if(source && a.source!==source) return false;
    this.byId.delete(id); this.cooldownUntil.delete(id); return true;
  }
  list(): RegistryEntry[] { return Array.from(this.byId.values()); }

  search(q: { tags?: string[]; source?: string; emotion?: string }): RegistryEntry[] {
    const want=(q && q.tags)||[]; let out=this.list();
    if(q && q.source) out=out.filter(a=>a.source===q.source);
    if(want.length) out=out.filter(a=> want.every(t=> (a.tags||[]).includes(String(t).toLowerCase())));
    if(q && q.emotion) out=out.filter(a=> ((a as any).emotionCompatibility||{})[q.emotion!]>=0.5);
    return out;
  }

  registerGestureLibrary(lib: Record<string, any[]>, emotionGestureMap?: Record<string,string>): void {
    const emo2gest=emotionGestureMap||{};
    const gest2emo:Record<string,number>={};
    for(const [emo,gest] of Object.entries(emo2gest)) gest2emo[gest]=Math.max(gest2emo[gest]||0,1.0);
    for(const [name,steps] of Object.entries(lib||{})){
      const tracks=stepsToTracks(steps);
      const totalMs=(steps||[]).reduce((s:number,st:any)=>s+((st&&st.ms)||0),0);
      this.register({ version:1, id:name, name, source:"builtin", type:"gesture", description:"Gerakan bawaan: "+name.replace(/_/g," "), tags:["builtin"], duration:+(totalMs/1000).toFixed(3), loop:false, intensity:{min:0.3,max:1.0,default:0.8} as any, emotionCompatibility: gest2emo[name]?{normal:0.7}:{}, cooldown:0, priority:60, aiEnabled:true, requires:[], tracks } as any);
    }
  }

  registerNativeGroups(groups: string[], info?: Record<string, any>): void {
    const meta=info||{};
    for(const g of groups||[]){ if(!g) continue; const m=meta[g]||{}; this.register({ version:1, id:"motion_"+g, name:g, source:"native", type:"motion3", description: m.description||("Motion bawaan model: "+g), tags:m.tags||[], duration:m.duration||2, loop:false, intensity:{min:0.3,max:1.0,default:0.8} as any, emotionCompatibility:m.emotionCompatibility||{}, cooldown:0, priority:90, aiEnabled:true, requires:[], tracks:[] } as any, {overwrite:true}); }
  }

  /** Daftarkan klip native PER-KLIP (menggantikan registerNativeGroups di
   * app.js): tiap .motion3.json jadi entri terpisah dengan data playback
   * {group,index} — klip di grup multi-klip dan grup "" kini bisa dimainkan.
   * Entri native model lama dibuang dulu supaya re-init antar model idempoten. */
  registerNativeClips(clips: NativeClip[], tagsByClip?: Record<string, string[]>): number {
    for(const [id,a] of Array.from(this.byId)) if(a.source==="native") this.byId.delete(id);
    let n=0;
    for(const c of clips||[]){
      if(!c || !c.id || typeof c.group !== "string" || !(c.index >= 0)) continue;
      const nat: { group: string; index: number; loop?: boolean } = { group:c.group, index:c.index };
      if(c.loop) nat.loop = true;
      const entry: any = { version:1, id:c.id, name:c.name||c.id, source:"native", type:"motion3", description:"Motion bawaan model: "+(c.name||c.id), tags:(tagsByClip&&tagsByClip[c.name])||[], duration:c.duration||2, loop:false, intensity:{min:0.3,max:1.0,default:0.8}, emotionCompatibility:{}, cooldown:0, priority:90, aiEnabled:true, requires:[], tracks:[], native:nat };
      if(c.file) entry.file = c.file;
      this.register(entry, {overwrite:true});
      n++;
    }
    return n;
  }

  replaceUserMotions(assets: MotionAsset[]): number {
    for(const [id,a] of Array.from(this.byId)) if(a.source==="user") this.byId.delete(id);
    let n=0; for(const a of assets||[]) if(this.register({...a, source:"user"} as any,{overwrite:true}).ok) n++; return n;
  }

  catalogForLLM(): ReturnType<typeof summaryForLLM>[] {
    return this.list().filter(a=> (a as any).aiEnabled!==false).map(a=> summaryForLLM(a as any));
  }

  canPlay(id: string, now?: number): boolean {
    const a=this.byId.get(id); if(!a) return false; const until=this.cooldownUntil.get(id)||0; return now==null || now>=until;
  }
  markPlayed(id: string, now: number): void {
    const a=this.byId.get(id); if(!a||!a.cooldown) return; this.cooldownUntil.set(id,(now||0)+a.cooldown);
  }

  // Factory facade so the proven engine (static/js/app.js) can keep calling
  // MotionRegistry.createRegistry() exactly as it did with the legacy UMD module.
  static createRegistry(): MotionRegistry {
    return new MotionRegistry();
  }
}
