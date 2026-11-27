// Only for public, identity-independent responses. Coalesce simultaneous misses.
export class SharedReadCache<T> {
  private entries = new Map<string, {until:number; value:T}>();
  private pending = new Map<string, Promise<T>>();
  private ttlMs:number; private maxKeys:number; private clock:()=>number;
  constructor(ttlMs:number, maxKeys:number, clock=Date.now) {this.ttlMs=ttlMs;this.maxKeys=maxKeys;this.clock=clock;}
  async get(key:string, load:()=>Promise<T>):Promise<T> {
    const cached=this.entries.get(key);
    if(cached && cached.until>this.clock()) return cached.value;
    const existing=this.pending.get(key);
    if(existing) return existing;
    if(!this.entries.has(key) && this.entries.size>=this.maxKeys) this.entries.delete(this.entries.keys().next().value!);
    if(this.pending.size>=this.maxKeys) throw new Error('Read cache busy');
    const work=Promise.resolve().then(load).then(value=>{
      this.entries.set(key,{until:this.clock()+this.ttlMs,value});return value;
    }).finally(()=>this.pending.delete(key));
    this.pending.set(key,work);return work;
  }
}
