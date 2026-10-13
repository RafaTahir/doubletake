export const QUOTE_TTL_MS = 30_000;
export type Route = {venue:string;pool:string;percent?:number};
export type RoundTrip = {
 notionalUsdc:number;buyTokens:number;sellUsdc:number;quotedPnlUsdc:number;quotedPnlPct:number;
 buyRoute:Route[];sellRoute:Route[];buyQuotedAt:number;sellQuotedAt:number;quotedAt:number;
 buyContextSlot?:number;sellContextSlot?:number;
};
export type Screening = {
 quotedPnlUsdc:number;quotedPnlPct:number;stressUsdc:number;networkUsdc:number;
 stressedPnlUsdc:number;stressedPnlPct:number;
 status:'negative'|'positive-unverified'|'zero'|'expired'|'unavailable';
};
export function quoteExpired(quotedAt:number,now=Date.now()):boolean {
 return !Number.isFinite(quotedAt)||quotedAt<=0||quotedAt>now+5_000||now-quotedAt>=QUOTE_TTL_MS;
}
export async function getRoundTrip(mint:string):Promise<RoundTrip> {
 const r=await fetch(`/api/arb?mint=${encodeURIComponent(mint)}`,{signal:AbortSignal.timeout(30000)});
 const d=await r.json();if(!r.ok)throw Error(d.error||'Route check unavailable');
 if(!Number.isFinite(d.buyQuotedAt)||!Number.isFinite(d.sellQuotedAt)||!Array.isArray(d.buyRoute)||!Array.isArray(d.sellRoute))throw Error('Incomplete route evidence. Recheck the round trip.');
 return d;
}
// Pool spot prices are a separate observation. They never enter round-trip P&L.
export function screen(trip:RoundTrip|undefined,now=Date.now()):Screening {
 const empty={quotedPnlUsdc:0,quotedPnlPct:0,stressUsdc:0,networkUsdc:.02,stressedPnlUsdc:0,stressedPnlPct:0};
 if(!trip||!Number.isFinite(trip.notionalUsdc)||trip.notionalUsdc<=0||!Number.isFinite(trip.sellUsdc)||trip.sellUsdc<=0||!Number.isFinite(trip.buyTokens)||trip.buyTokens<=0||!Number.isFinite(trip.quotedAt)||trip.quotedAt<=0)return {...empty,status:'unavailable'};
 if(quoteExpired(trip.quotedAt,now))return {...empty,status:'expired'};
 const quotedPnlUsdc=trip.sellUsdc-trip.notionalUsdc;
 const quotedPnlPct=quotedPnlUsdc/trip.notionalUsdc*100;
 const stressUsdc=trip.notionalUsdc*.01,networkUsdc=.02;
 const stressedPnlUsdc=quotedPnlUsdc-stressUsdc-networkUsdc;
 return {quotedPnlUsdc,quotedPnlPct,stressUsdc,networkUsdc,stressedPnlUsdc,stressedPnlPct:stressedPnlUsdc/trip.notionalUsdc*100,status:quotedPnlUsdc>0?'positive-unverified':quotedPnlUsdc<0?'negative':'zero'};
}
