import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { isWithinAtlantaMetro, normalizeStreetName, classifyJurisdiction, type JurisdictionType } from './geo.ts';
import { googleGeocodingEnabled, type GoogleStreet } from './googleGeocoding.ts';
import { hashBytes } from './verificationPolicy.ts';

// City of Atlanta open-data street centerline layer. Optional until the team has confirmed
// permitted use and availability. Never send a user identifier, photograph or notes here.
export const CITY_ROAD_URL='https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/FeatureServer/33/query';
export type StreetSource='city_centerline'|'user_observed'|'google_geocoding';
export type RoadMatch={streetName:string;jurisdiction:JurisdictionType;streetSource:'city_centerline'};
export function cleanObservedStreet(value:unknown):string {
  if(typeof value!=='string')return '';
  const s=value.trim().replace(/\s+/g,' ');
  // Road label only, not a house address, arbitrary notes, coordinates or email.
  if(!s||s.length>128||!/[A-Za-z]/.test(s)||!/^[-'’. A-Za-z0-9&/]+$/.test(s)||/^\d{1,6}\s+[A-Za-z]/.test(s)||/^near\s|^coordinate|^unknown|^unverified/i.test(s))return '';
  return s;
}
function nearestDistance(lat:number,lng:number,paths:unknown):number {
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
export function matchCityRoad(features:unknown,lat:number,lng:number):RoadMatch|null {
  if(!Array.isArray(features)||features.length>60)return null;
  const ranked=features.flatMap(f=>{
    const a=f?.attributes;if(!a||a.STATUS!=='Active')return [];
    const street=cleanObservedStreet([a.PREDIR,a.NAME,a.POSTTYPE,a.POSTDIR].filter(x=>typeof x==='string'&&x.trim()).join(' '))||cleanObservedStreet(a.LABEL);
    const distance=nearestDistance(lat,lng,f.geometry?.paths);
    if(!street||distance>35)return [];
    const ownership=String(a.OWNERSHIP||'').trim().toLowerCase(),jurisdiction=String(a.JURISDICTION||'').trim().toLowerCase();
    const stateRoad=!![a.INSTHWYNUM,a.USHWYNUM,a.STHWYNUM].find(x=>typeof x==='string'&&x.trim()&&!/^0+$/.test(x.trim()));
    const roadOwner:JurisdictionType=stateRoad||/^(state|gdot|georgia dot|georgia department of transportation)$/.test(ownership)?'gdot':jurisdiction==='atlanta'&&/^(atlanta|city of atlanta)$/.test(ownership)?'atldot':'unknown';
    return [{streetName:street,jurisdiction:roadOwner,streetSource:'city_centerline' as const,distance}];
  }).sort((a,b)=>a.distance-b.distance);
  const best=ranked[0];if(!best)return null;
  // At intersections/parallel streets, ask the reporter rather than choosing a wrong road.
  if(ranked.slice(1).some(r=>r.distance-best.distance<10&&(normalizeStreetName(r.streetName)!==normalizeStreetName(best.streetName)||r.jurisdiction!==best.jurisdiction)))return null;
  return {streetName:best.streetName,jurisdiction:best.jurisdiction,streetSource:best.streetSource};
}
const refFor=(db:Firestore,uid:string,lat:number,lng:number)=>db.collection('roadLookups').doc(hashBytes(JSON.stringify([uid,lat,lng])));
export async function lookupCityRoad(db:Firestore,uid:string,lat:number,lng:number,fetcher:typeof fetch=fetch):Promise<RoadMatch|null> {
  if(process.env.PATCHUP_CITY_ROADS_ENABLED!=='true'||!isWithinAtlantaMetro(lat,lng))return null;
  const url=new URL(CITY_ROAD_URL);
  const params={f:'json',where:"STATUS = 'Active'",geometry:JSON.stringify({x:lng,y:lat,spatialReference:{wkid:4326}}),geometryType:'esriGeometryPoint',inSR:'4326',outSR:'4326',spatialRel:'esriSpatialRelIntersects',distance:'35',units:'esriSRUnit_Meter',outFields:'NAME,PREDIR,POSTTYPE,POSTDIR,LABEL,OWNERSHIP,JURISDICTION,STATUS,INSTHWYNUM,USHWYNUM,STHWYNUM',returnGeometry:'true',resultRecordCount:'60'};
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  try{
    const response=await fetcher(url,{signal:AbortSignal.timeout(6000),redirect:'error'});
    if(!response.ok)return null;
    const raw=await response.text();if(raw.length>1_000_000)return null;
    const data=JSON.parse(raw);if(data.error||data.exceededTransferLimit)return null;
    const match=matchCityRoad(data.features,lat,lng);if(!match)return null;
    await refFor(db,uid,lat,lng).set({...match,ownerId:uid,expiresAt:Timestamp.fromMillis(Date.now()+15*60_000)});
    return match;
  }catch{return null;}
}
export async function saveGoogleRoad(db:Firestore,uid:string,lat:number,lng:number,match:GoogleStreet,jurisdiction:JurisdictionType='unknown') {
  if (!googleGeocodingEnabled()) throw new Error('Google location lookup disabled.');
  await refFor(db,uid,lat,lng).set({...match,jurisdiction,streetSource:'google_geocoding',ownerId:uid,expiresAt:Timestamp.fromMillis(Date.now()+15*60_000)});
  return {...match,jurisdiction,streetSource:'google_geocoding' as const};
}
export async function confirmRoad(db:Firestore,uid:string,lat:number,lng:number,street:unknown,source:unknown) {
  const streetName=cleanObservedStreet(street);if(!streetName)throw new Error('Enter the street name from a street sign or your own knowledge, not a home address.');
  let match: {streetName:string;jurisdiction:JurisdictionType;streetSource:StreetSource}={streetName,jurisdiction:classifyJurisdiction(streetName,'','')==='gdot'?'gdot':'unknown',streetSource:'user_observed'};
  if(source==='city_centerline'||source==='google_geocoding'){
    if(source==='google_geocoding'&&!googleGeocodingEnabled())throw new Error('Google location lookup disabled. Refresh or independently enter the road name.');
    const proof=(await refFor(db,uid,lat,lng).get()).data();
    if(!proof||proof.streetSource!==source||proof.ownerId!==uid||!(Number(proof.expiresAt?.toMillis?.())>Date.now())||normalizeStreetName(proof.streetName)!==normalizeStreetName(streetName)||!['atldot','gdot','unknown'].includes(proof.jurisdiction))throw new Error('Street lookup expired. Refresh the location or enter the street name yourself.');
    match={streetName:proof.streetName,jurisdiction:proof.jurisdiction,streetSource:source};
    if(source==='google_geocoding')return {...match,normalizedStreet:normalizeStreetName(match.streetName),formattedAddress:proof.formattedAddress||match.streetName,city:proof.city||'Atlanta',state:'GA',neighborhood:'',postalCode:proof.postalCode||'',placeId:proof.placeId||''};
  }else if(source!=='user_observed')throw new Error('Confirm the source of the street name.');
  return {...match,normalizedStreet:normalizeStreetName(match.streetName),formattedAddress:`${match.streetName}, Atlanta, GA`,city:'Atlanta',state:'GA',neighborhood:'',postalCode:'',placeId:''};
}
