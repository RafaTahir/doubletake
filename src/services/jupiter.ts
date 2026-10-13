import type {Route} from './arb';
export type Quote={inputAmount:number;outputAmount:number;minOutputAmount:number;priceImpactPct:number;route:(Route&{feeAmount?:string;feeMint?:string})[];slippageBps:number;platformFee:null|{amount:string;feeBps:number};quotedAt:number;contextSlot?:number;source:string};
export async function getQuote(mint:string,direction:'buy'|'sell'):Promise<Quote>{
 const r=await fetch(`/api/quote?mint=${encodeURIComponent(mint)}&direction=${direction}`,{signal:AbortSignal.timeout(16000)});
 const d=await r.json();if(!r.ok)throw Error(d.error||'Quote unavailable');
 if(!Number.isFinite(d.inputAmount)||d.inputAmount<=0||!Number.isFinite(d.outputAmount)||d.outputAmount<=0||!Number.isFinite(d.minOutputAmount)||d.minOutputAmount<0||!Number.isFinite(d.priceImpactPct)||!Number.isFinite(d.slippageBps)||!Number.isFinite(d.quotedAt)||!Array.isArray(d.route))throw Error('Incomplete quote. Try the route check again.');
 return d;
}
