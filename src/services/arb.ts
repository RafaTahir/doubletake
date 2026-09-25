import type {Price} from './market';
export type RoundTrip={notionalUsdc:number;buyTokens:number;sellUsdc:number;roundTripDragPct:number;buyRoute:string[];sellRoute:string[];quotedAt:number};
export type Screening={grossPct:number;routeDragPct:number;stressPct:number;networkPct:number;netPct:number;status:'not-viable'|'candidate'|'unverified'};
export async function getRoundTrip(mint:string):Promise<RoundTrip>{const r=await fetch(`/api/arb?mint=${encodeURIComponent(mint)}`,{signal:AbortSignal.timeout(30000)});const d=await r.json();if(!r.ok)throw Error(d.error||'Route check unavailable');return d}
export function screen(price:Price|undefined,trip:RoundTrip|undefined):Screening{
 if(!price||price.stale||price.dex===undefined||price.second===undefined||!trip||!Number.isFinite(trip.roundTripDragPct))return {grossPct:0,routeDragPct:0,stressPct:1,networkPct:.02,netPct:0,status:'unverified'};
 const grossPct=(Math.max(price.dex,price.second)/Math.min(price.dex,price.second)-1)*100;
 // This is a deliberately conservative SCREEN, not a realizable two-venue trade.
 const routeDragPct=Math.max(0,trip.roundTripDragPct),stressPct=1,networkPct=.02;
 const netPct=grossPct-routeDragPct-stressPct-networkPct;
 return {grossPct,routeDragPct,stressPct,networkPct,netPct,status:netPct>0?'candidate':'not-viable'};
}
