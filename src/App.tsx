import React, { useEffect, useMemo, useState } from 'react';
import { FileCard, Header, Group, Closing, Callout } from '@instinct/files';
import assets from './data/assets.json';
import './style.css';
import previewArt from './preview-art.png';

type Asset = typeof assets[number];
type Holding = { symbol: string; amount: number };
type Price = { dex?: number; second?: number; pool?: string; secondPool?: string; liquidity?: number; secondLiquidity?: number; checked: number; error?: string };
const DEMO: Holding[] = [{ symbol: 'AAPLx', amount: .42 }, { symbol: 'TSLAx', amount: .15 }, { symbol: 'NVDAx', amount: .75 }];
const RPC = 'https://api.mainnet-beta.solana.com';
const SPL = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const money=(n?:number)=>n===undefined?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
const time=(t:number)=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur',timeZoneName:'short'}).format(t);
const mintMap=new Map(assets.map(a=>[a.mint,a.symbol]));
async function walletHoldings(address:string):Promise<Holding[]> {
  const batches=await Promise.all(SPL.map(async(programId,id)=>{
    const res=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:id+1,method:'getTokenAccountsByOwner',params:[address,{programId},{encoding:'jsonParsed'}]})});
    if(!res.ok) throw new Error(`Solana RPC returned ${res.status}`);
    const body=await res.json(); if(body.error) throw new Error(body.error.message||'Solana RPC error');
    return body.result?.value||[];
  }));
  const balances=new Map<string,number>();
  for(const account of batches.flat()) { const info=account.account?.data?.parsed?.info; const sym=mintMap.get(info?.mint); const value=Number(info?.tokenAmount?.uiAmountString||0); if(sym&&value>0) balances.set(sym,(balances.get(sym)||0)+value); }
  return [...balances].map(([symbol,amount])=>({symbol,amount}));
}
async function fetchPrice(asset:Asset):Promise<Price> {
  const checked=Date.now(); const out:Price={checked};
  try {
    const res=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${asset.mint}`);
    if(!res.ok)throw Error(`DEX market HTTP ${res.status}`);
    const d=await res.json();
    const pools=(d.pairs||[]).filter((p:any)=>p.chainId==='solana'&&p.baseToken?.address===asset.mint&&p.quoteToken?.symbol==='USDC'&&Number(p.priceUsd)>0&&Number(p.liquidity?.usd)>1000).sort((a:any,b:any)=>(Number(b.liquidity?.usd)||0)-(Number(a.liquidity?.usd)||0));
    if(pools.length){out.dex=Number(pools[0].priceUsd);out.pool=pools[0].url;out.liquidity=Number(pools[0].liquidity?.usd)||0;}
    if(pools.length>1){out.second=Number(pools[1].priceUsd);out.secondPool=pools[1].url;out.secondLiquidity=Number(pools[1].liquidity?.usd)||0;}
    if(!pools.length)out.error='No qualifying USDC pools found.';
  } catch(e:any){out.error=e.message||'Market data unavailable.'}
  return out;
}
function markExplain(p?:Price) {
  if(!p||p.dex===undefined||p.second===undefined)return 'Two live pools are needed to calculate a venue gap.';
  const gap=(p.dex/p.second-1)*100;
  if(Math.abs(gap)<.15)return 'The two pools are close, but a trade may still differ after spread, fees and slippage.';
  return gap>0?'Pool A is above pool B. Depth, spread and timing can change the quote you actually get.':'Pool A is below pool B. Depth, spread and timing can change the quote you actually get.';
}
function Card({holding,price}:{holding:Holding;price?:Price}) {
  const a=assets.find(a=>a.symbol===holding.symbol)!;
  const diff=price?.second!==undefined&&price?.dex!==undefined?(price.dex/price.second-1)*100:undefined;
  return <article className="asset-card">
    <div className="asset-head"><div><span className="ticker">{a.symbol}</span><span className="asset-name">{a.name}</span></div><span className="amount">{holding.amount.toLocaleString('en-US',{maximumFractionDigits:6})} tokens</span></div>
    <div className="price-grid"><div><span className="kicker">Pool A / token</span><strong>{money(price?.dex)}</strong><small>{price?.pool?'Largest observed USDC pool':'No matching live USDC pool'}</small></div><div><span className="kicker">Pool B / token</span><strong>{money(price?.second)}</strong><small>{price?.second!==undefined?'Second-largest USDC pool':'No second live USDC pool'}</small></div></div>
    <div className="gap"><div><span className="kicker">Observed gap</span><strong className={diff!==undefined&&Math.abs(diff)>=.15?'alert':''}>{diff===undefined?'—':`${diff>=0?'+':''}${diff.toFixed(2)}%`}</strong></div><p>{markExplain(price)}</p></div>
    {price?.pool&&<div className="pool-links"><a href={price.pool} target="_blank" rel="noopener noreferrer">Pool A ↗</a>{price?.secondPool&&<a href={price.secondPool} target="_blank" rel="noopener noreferrer">Pool B ↗</a>}</div>}
  </article>
}
export function App(){
  const [input,setInput]=useState('');const [address,setAddress]=useState('');const [mode,setMode]=useState<'demo'|'wallet'>('demo');const [holdings,setHoldings]=useState<Holding[]>(DEMO);const [loading,setLoading]=useState(false);const [message,setMessage]=useState('');const [prices,setPrices]=useState<Record<string,Price>>({});const [tick,setTick]=useState(0);
  useEffect(()=>{let cancelled=false;const relevant=assets.filter(a=>holdings.some(h=>h.symbol===a.symbol)); Promise.all(relevant.map(async a=>[a.symbol,await fetchPrice(a)] as const)).then(rows=>{if(!cancelled)setPrices(Object.fromEntries(rows))}).catch(()=>{if(!cancelled)setMessage('Price providers did not answer. Retry shortly.');});return()=>{cancelled=true}},[holdings,tick]);
  const count=useMemo(()=>Object.values(prices).filter(p=>p.dex!==undefined&&p.second!==undefined).length,[prices]);
  async function inspect(e:React.FormEvent){e.preventDefault();const value=input.trim();if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)){setMessage('Enter a Solana base58 public wallet address (32–44 characters).');return}setLoading(true);setMessage('Looking up SPL Token and Token-2022 balances on Solana mainnet…');try{const h=await walletHoldings(value);setAddress(value);setMode('wallet');setHoldings(h);setPrices({});setMessage(h.length?'Balances found. Fetching quotes…':'No supported xStocks with a positive balance in this wallet. Try the demo.')}catch(err:any){setMessage(`Wallet lookup failed: ${err.message||'network error'}. The demo still works.`)}finally{setLoading(false)}}
  function demo(){setMode('demo');setAddress('');setHoldings(DEMO);setPrices({});setMessage('Example holdings only. Quotes are requested live.');setTick(n=>n+1)}
  return <FileCard>
    <Header title="Why is my xStock a different price?" fact="A live venue-gap lens for tokenized stocks on Solana" intro="The same token can show two prices at the same moment. See the onchain venue gap, then learn why it happens." />
    <div className="hero"><img className="hero-art" src={previewArt} alt="Abstract overlapping market orbits, an illustration of two price paths"/><div className="hero-motif" aria-hidden="true"><span className="signal one"/><span className="signal two"/><span className="signal three"/><i/><b>≠</b></div><div className="hero-copy"><span className="eyebrow">DOUBLETAKE · EXPLAIN, DON'T TRADE</span><p>One token. Two pools. <em>Which price is real?</em></p></div></div>
    <Group label="Start with a wallet" heading><p className="lead">Enter a public Solana address to inspect supported xStock balances. Some public RPC endpoints block browser requests, so this may be unavailable; the live market comparison works in example mode.</p><form onSubmit={inspect} className="wallet-form"><label htmlFor="wallet">Public wallet address</label><div className="input-row"><input id="wallet" value={input} onChange={e=>setInput(e.target.value)} spellCheck={false} autoComplete="off" placeholder="Paste a Solana mainnet address"/><button type="submit" disabled={loading}>{loading?'Checking…':'Inspect wallet'}</button></div></form><div className="demo-row"><span>Just looking?</span><button type="button" onClick={demo}>Explore example portfolio ↗</button></div>{message&&<p className="status" role="status">{message}</p>}</Group>
    <Group label="Your view" heading><div className="section-bar"><span className="mode">{mode==='demo'?'EXAMPLE PORTFOLIO':'LIVE WALLET BALANCES'}</span><button type="button" onClick={()=>setTick(n=>n+1)}>Refresh prices ↻</button></div>{mode==='wallet'&&<p className="address">{address}</p>}{holdings.length?<><div className="holdings">{holdings.map(h=><Card key={h.symbol} holding={h} price={prices[h.symbol]}/>)}</div><p className="freshness">{Object.values(prices).length?`${count}/${holdings.length} paired quotes · Checked ${time(Math.max(...Object.values(prices).map(p=>p.checked)))}`:'Fetching live quotes…'} · Indicative, not executable prices</p></>:<Callout title="Nothing to compare yet">This wallet has no positive balance among the five currently supported xStocks. Try the example or another public address.</Callout>}</Group>
    <Group label="Why a gap?" heading><div className="reasons"><div><span>01</span><h3>Different clocks</h3><p>US shares have exchange hours, while Solana pools can trade outside them. A token need not match a closed-market share quote.</p></div><div><span>02</span><h3>Different markets</h3><p>Two Solana USDC pools can post different prices for the same token. This screen compares venues, not a US share price.</p></div><div><span>03</span><h3>Different depth</h3><p>Thin pools, spreads and trade size can move a fill away from a screen quote. Check liquidity before drawing conclusions.</p></div></div></Group>
    <Group label="About this prototype" heading><p className="lead">The example holdings are fictional, but pool prices are fetched live from DexScreener. For each verified xStock Solana mint, we compare the two USDC pools with the highest reported USD liquidity above $1,000. Wallet lookup attempts read-only Solana RPC calls for SPL Token and Token-2022; some browsers or public RPCs reject those calls. Five mints are recognized: AAPLx, TSLAx, NVDAx, MSFTx and GOOGLx. Other assets are ignored, not counted as zero.</p><p className="lead">These are DEX pool quotes, not US share prices, issuer indicative values, redemption prices or executable trade prices. Pyth's live price API requires an API key; this prototype does not claim Pyth bounty eligibility.</p><div className="source-links"><a href="https://docs.xstocks.fi/apis/openapi.md" target="_blank" rel="noopener noreferrer">xStocks mint registry ↗</a><a href="https://docs.pyth.network/price-feeds/core/upgrade/preparing" target="_blank" rel="noopener noreferrer">Pyth access note ↗</a><a href="https://solana.com/docs/rpc/http/gettokenaccountsbyowner" target="_blank" rel="noopener noreferrer">Solana RPC ↗</a><a href="https://docs.dexscreener.com/api/reference" target="_blank" rel="noopener noreferrer">DEX market data ↗</a></div></Group>
    <Closing>DoubleTake · Built for the Solana hackathon · Read-only prototype · Live market quotes can be delayed or unavailable; no trades or wallet signatures.</Closing>
  </FileCard>
}
