import { Timestamp, type Firestore } from 'firebase-admin/firestore';
import { isWithinAtlantaMetro, normalizeStreetName, type JurisdictionType } from './geo.ts';
import { requireIndependentSource, isIndependentRecord, LOCATION_POLICY_VERSION, type IndependentStreetSource } from './locationPolicy.ts';
import { readFileSync } from 'node:fs';
import { nearestDistance, matchTigerRoad, cleanObservedStreet, type TigerRoad } from './tigerRoads.ts';
import { hashBytes } from './verificationPolicy.ts';

// City of Atlanta open-data street centerline layer. Optional until the team has confirmed
// permitted use and availability. Never send a user identifier, photograph or notes here.
export const CITY_ROAD_URL='https://gis.atlantaga.gov/dpcd/rest/services/OpenDataService1/FeatureServer/33/query';
export { cleanObservedStreet } from './tigerRoads.ts';
export type StreetSource=IndependentStreetSource;
export type RoadMatch={streetName:string;jurisdiction:JurisdictionType;streetSource:'city_centerline'|'tiger_line'};
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
  if(process.env.PATCHUP_CITY_ROADS_ENABLED!=='true'||process.env.PATCHUP_CITY_ROADS_REUSE_APPROVED!=='true'||!isWithinAtlantaMetro(lat,lng))return null;
  const url=new URL(CITY_ROAD_URL);
  const params={f:'json',where:"STATUS = 'Active'",geometry:JSON.stringify({x:lng,y:lat,spatialReference:{wkid:4326}}),geometryType:'esriGeometryPoint',inSR:'4326',outSR:'4326',spatialRel:'esriSpatialRelIntersects',distance:'35',units:'esriSRUnit_Meter',outFields:'NAME,PREDIR,POSTTYPE,POSTDIR,LABEL,OWNERSHIP,JURISDICTION,STATUS,INSTHWYNUM,USHWYNUM,STHWYNUM',returnGeometry:'true',resultRecordCount:'60'};
  Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,v));
  try{
    const response=await fetcher(url,{signal:AbortSignal.timeout(6000),redirect:'error'});
    if(!response.ok)return null;
    const raw=await response.text();if(raw.length>1_000_000)return null;
    const data=JSON.parse(raw);if(data.error||data.exceededTransferLimit)return null;
    const match=matchCityRoad(data.features,lat,lng);if(!match)return null;
    await refFor(db,uid,lat,lng).set({...match,locationPolicyVersion:LOCATION_POLICY_VERSION,ownerId:uid,expiresAt:Timestamp.fromMillis(Date.now()+15*60_000)});
    return match;
  }catch{return null;}
}
// Local TIGER/Line road features, prepared offline from Census files. No Google inputs.
let localRoads: TigerRoad[] | undefined;
export async function lookupTigerRoad(db:Firestore,uid:string,lat:number,lng:number):Promise<RoadMatch|null>{
  const path=process.env.PATCHUP_TIGER_ROADS_FILE;if(!path||!isWithinAtlantaMetro(lat,lng))return null;
  try{if(!localRoads){const raw=JSON.parse(readFileSync(path,'utf8'));if(raw.source!=='US Census Bureau TIGER/Line 2025 ROADS'||!Array.isArray(raw.features)||raw.features.length>500000)return null;localRoads=raw.features;}
    const match=matchTigerRoad(localRoads!,lat,lng);if(match)await refFor(db,uid,lat,lng).set({...match,locationPolicyVersion:LOCATION_POLICY_VERSION,ownerId:uid,expiresAt:Timestamp.fromMillis(Date.now()+15*60_000)});return match;
  }catch{return null;}
}
export async function confirmRoad(db:Firestore,uid:string,lat:number,lng:number,street:unknown,source:unknown,observedIndependently:unknown=false) {
  requireIndependentSource(source);
  if(source==='user_observed' && observedIndependently!==true)throw new Error('Confirm the street from independent observation, not Google Maps.');
  const streetName=cleanObservedStreet(street);if(!streetName)throw new Error('Enter the street name from a street sign or your own knowledge, not a home address.');
  let match: {streetName:string;jurisdiction:JurisdictionType;streetSource:StreetSource}={streetName,jurisdiction:'unknown',streetSource:'user_observed'};
  if(source==='city_centerline'||source==='tiger_line'){
    if(source==='city_centerline'&&(process.env.PATCHUP_CITY_ROADS_ENABLED!=='true'||process.env.PATCHUP_CITY_ROADS_REUSE_APPROVED!=='true'))throw new Error('Independent city provider is disabled.');
    if(source==='tiger_line'&&!process.env.PATCHUP_TIGER_ROADS_FILE)throw new Error('Independent Census provider is disabled.');
    const proof=(await refFor(db,uid,lat,lng).get()).data();
    if(!proof||!isIndependentRecord(proof)||proof.streetSource!==source||proof.ownerId!==uid||!(Number(proof.expiresAt?.toMillis?.())>Date.now())||normalizeStreetName(proof.streetName)!==normalizeStreetName(streetName)||!['atldot','gdot','unknown'].includes(proof.jurisdiction))throw new Error('Street lookup expired. Refresh the location or enter the street name yourself.');
    match={streetName:proof.streetName,jurisdiction:proof.jurisdiction,streetSource:source};
  }else if(source!=='user_observed')throw new Error('Confirm the source of the street name.');
  return {...match,normalizedStreet:normalizeStreetName(match.streetName),formattedAddress:match.streetName,city:'Atlanta',state:'GA',neighborhood:'',postalCode:'',placeId:''};
}
