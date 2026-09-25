import assets from '../data/assets.json';
export type Asset=typeof assets[number];
export type Holding={symbol:string;amount:number};
export type Pool={url:string;name:string;pair:string;liquidity:number};
export type Price={dex?:number;second?:number;pool?:Pool;secondPool?:Pool;checked:number;stale?:boolean;error?:string};
export type Point={at:number;gap:number};
export const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const DEMO:Holding[]=[{symbol:'AAPLx',amount:.42},{symbol:'TSLAx',amount:.15},{symbol:'NVDAx',amount:.75}];
export const money=(n?:number)=>n===undefined?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
export const time=(t:number)=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur',timeZoneName:'short'}).format(t);
export async function fetchPrice(asset:Asset):Promise<Price>{
 const checked=Date.now(),out:Price={checked};
 try {const res=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${asset.mint}`,{signal:AbortSignal.timeout(12000)});if(!res.ok)throw Error(`DEX market HTTP ${res.status}`);
 const d=await res.json();const pools=(d.pairs||[]).filter((p:any)=>p.chainId==='solana'&&p.baseToken?.address===asset.mint&&p.quoteToken?.address===USDC&&Number(p.priceUsd)>0&&Number(p.liquidity?.usd)>1000).sort((a:any,b:any)=>(Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0));
 const pool=(p:any):Pool=>({url:p.url,name:p.dexId||'Unknown DEX',pair:p.pairAddress||'',liquidity:Number(p.liquidity?.usd)||0});
 if(pools[0]){out.dex=Number(pools[0].priceUsd);out.pool=pool(pools[0])}if(pools[1]){out.second=Number(pools[1].priceUsd);out.secondPool=pool(pools[1])}if(!pools.length)out.error='No qualifying verified-USDC pools found.';
 }catch(e:any){out.error=e.message||'Market data unavailable.'}return out;
}
export async function walletHoldings(address:string):Promise<Holding[]>{
 const r=await fetch(`/api/holdings?address=${encodeURIComponent(address)}`,{signal:AbortSignal.timeout(16000)});const d=await r.json();if(!r.ok)throw Error(d.error||'Wallet lookup unavailable');
 const mintMap=new Map(assets.map(a=>[a.mint,a.symbol]));const balances=new Map<string,number>();for(const account of d.accounts||[]){const sym=mintMap.get(account.mint),amount=Number(account.amount||0);if(sym&&amount>0)balances.set(sym,(balances.get(sym)||0)+amount)}return [...balances].map(([symbol,amount])=>({symbol,amount}));
}
export function validSolanaAddress(value:string){const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;let n=0n;for(const char of value){const i=alphabet.indexOf(char);if(i<0)return false;n=n*58n+BigInt(i)}let bytes=0;while(n>0n){bytes++;n>>=8n}return(value.match(/^1*/)?.[0].length||0)+bytes===32}
export function markExplain(p?:Price){if(!p||p.dex===undefined||p.second===undefined)return'Two live pools are needed to calculate a venue gap.';const gap=(p.dex/p.second-1)*100;if(Math.abs(gap)<.15)return'The two pools are close, but a trade may still differ after spread, fees and slippage.';return gap>0?'Pool A is above pool B. Depth, spread and timing can change the quote you actually get.':'Pool A is below pool B. Depth, spread and timing can change the quote you actually get.'}
