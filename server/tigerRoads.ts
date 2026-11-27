import { normalizeStreetName } from './geo.ts';
export type TigerRoad={streetName:string;paths:unknown;bbox:[number,number,number,number]};
export function cleanObservedStreet(value:unknown):string {
  if(typeof value!=='string')return '';
  const s=value.trim().replace(/\s+/g,' ');
  // Road label only, not a house address, arbitrary notes, coordinates or email.
  if(!s||s.length>128||!/[A-Za-z]/.test(s)||!/^[-'’. A-Za-z0-9&/]+$/.test(s)||/^\d{1,6}\s+[A-Za-z]/.test(s)||/^near\s|^coordinate|^unknown|^unverified/i.test(s))return '';
  return s;
}
export function nearestDistance(lat:number,lng:number,paths:unknown):number {
  if(!Array.isArray(paths))return Infinity;
  const mx=111320*Math.cos(lat*Math.PI/180),my=110574;
  let best=Infinity;
  for(const path of paths.slice(0,100)){
    if(!Array.isArray(path)||path.length<2||path.length>10000)continue;
    for(let i=1;i<path.length;i++){
      const a=path[i-1],b=path[i];if(!Array.isArray(a)||!Array.isArray(b)||![a[0],a[1],b[0],b[1]].every(Number.isFinite))continue;
      const ax=(a[0]-lng)*mx,ay=(a[1]-lat)*my,bx=(b[0]-lng)*mx,by=(b[1]-lat)*my,dx=bx-ax,dy=by-ay;
      const t=Math.max(0,Math.min(1,-(ax*dx+ay*dy)/(dx*dx+dy*dy||1)));
      best=Math.min(best,Math.hypot(ax+t*dx,ay+t*dy));
    }
  }return best;
}
export function matchTigerRoad(features: TigerRoad[],lat:number,lng:number):{streetName:string;jurisdiction:'unknown';streetSource:'tiger_line'}|null {
  const ranked=features.flatMap(f=>{if(!f||!Array.isArray(f.bbox)||f.bbox.length!==4||!f.bbox.every(Number.isFinite))return [];const [west,south,east,north]=f.bbox;if(lng<west-.0005||lng>east+.0005||lat<south-.0005||lat>north+.0005)return [];const streetName=cleanObservedStreet(f.streetName);const distance=nearestDistance(lat,lng,f.paths);return streetName&&distance<=35?[{streetName,distance}]:[];}).sort((a,b)=>a.distance-b.distance);
  const best=ranked[0];if(!best||ranked.some(r=>r.distance-best.distance<10&&normalizeStreetName(r.streetName)!==normalizeStreetName(best.streetName)))return null;
  return {streetName:best.streetName,jurisdiction:'unknown',streetSource:'tiger_line'};
}
