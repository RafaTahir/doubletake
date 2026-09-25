import React, { useEffect, useMemo, useState } from 'react';
import { FileCard, Header, Group, Closing, Callout } from './ui';
import assets from './data/assets.json';
import './style.css';
import previewArt from './preview-art.png';

type Asset = typeof assets[number];
type Holding = { symbol: string; amount: number };
type Price = { dex?: number; second?: number; pool?: string; secondPool?: string; liquidity?: number; secondLiquidity?: number; checked: number; error?: string };
type Point = { at: number; gap: number };
const POLL_MS = 45_000;
const DEMO: Holding[] = [{ symbol: 'AAPLx', amount: .42 }, { symbol: 'TSLAx', amount: .15 }, { symbol: 'NVDAx', amount: .75 }];
const RPC = 'https://api.mainnet-beta.solana.com';
const SPL = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const money=(n?:number)=>n===undefined?'Unavailable':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n);
const time=(t:number)=>new Intl.DateTimeFormat('en-US',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Kuala_Lumpur',timeZoneName:'short'}).format(t);
const mintMap=new Map(assets.map(a=>[a.mint,a.symbol]));
function validSolanaAddress(value:string){
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))return false;
  let n=0n;for(const char of value){const i=alphabet.indexOf(char);if(i<0)return false;n=n*58n+BigInt(i)}
  let bytes=0;while(n>0n){bytes++;n>>=8n}
  return (value.match(/^1*/)?.[0].length||0)+bytes===32;
}
function Sparkline({points}:{points:Point[]}){
  if(points.length<2)return <p className="trend-empty">A line appears after the next live check. Leave this page open to watch the gap.</p>;
  const values=points.map(p=>p.gap),lo=Math.min(...values),hi=Math.max(...values),range=Math.max(hi-lo,.02);
  const path=points.map((p,i)=>`${8+i*224/(points.length-1)},${48-(p.gap-lo)/range*36}`).join(' ');
  return <div className="trend-chart"><svg viewBox="0 0 240 56" role="img" aria-label={`Observed venue gap moved from ${values[0].toFixed(2)} to ${values[values.length-1].toFixed(2)} percent over ${points.length} checks`} preserveAspectRatio="none"><line x1="8" x2="232" y1="48" y2="48" stroke="#dbe8e2"/><polyline fill="none" stroke="#198270" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" points={path}/><circle cx="232" cy={path.split(' ').at(-1)?.split(',')[1]} r="3.5" fill="#198270"/></svg><div className="trend-times"><span>{time(points[0].at)}</span><span>{time(points[points.length-1].at)}</span></div></div>;
}
async function walletHoldings(address:string):Promise<Holding[]> {
  const batches=await Promise.all(SPL.map(async(programId,id)=>{
    const res=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({jsonrpc:'2.0',id:id+1,method:'getTokenAccountsByOwner',params:[address,{programId},{encoding:'jsonParsed'}]})});
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
    const res=await fetch(`https://api.dexscreener.com/latest/dex/tokens/${asset.mint}`,{signal:AbortSignal.timeout(12000)});
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
function Card({holding,price,points,refreshing}:{holding:Holding;price?:Price;points:Point[];refreshing:boolean}) {
  const [expanded,setExpanded]=useState(false);
  const a=assets.find(a=>a.symbol===holding.symbol)!;
  const diff=price?.second!==undefined&&price?.dex!==undefined?(price.dex/price.second-1)*100:undefined;
  return <article className={`asset-card ${expanded?'is-open':''}`}>
    <div className="asset-head"><div><span className="ticker">{a.symbol}</span><span className="asset-name">{a.name}</span></div><span className="amount">{holding.amount.toLocaleString('en-US',{maximumFractionDigits:6})} tokens</span></div>
    <div className="price-grid"><div><span className="kicker">Pool A / token</span><strong>{money(price?.dex)}</strong><small>{price?.pool?'Largest observed USDC pool':'No matching live USDC pool'}</small></div><div><span className="kicker">Pool B / token</span><strong>{money(price?.second)}</strong><small>{price?.second!==undefined?'Second-largest USDC pool':'No second live USDC pool'}</small></div></div>
    <div className="gap"><div><span className="kicker">Observed gap</span><strong className={diff!==undefined&&Math.abs(diff)>=.15?'alert':''}>{diff===undefined?'—':`${diff>=0?'+':''}${diff.toFixed(2)}%`}</strong></div><p>{markExplain(price)}</p></div>
    {price?.error&&<p className="card-error">{price.error} Try Refresh prices.</p>}
    <button className="detail-toggle" type="button" aria-expanded={expanded} aria-controls={`detail-${a.symbol}`} onClick={()=>setExpanded(v=>!v)}>{expanded?'Hide market detail −':'Explore market detail +'}<span aria-hidden="true">↗</span></button>
    {expanded&&<div className="card-detail" id={`detail-${a.symbol}`}><div className="detail-title"><span className="kicker">Live gap trail</span><span>{points.length} {points.length===1?'check':'checks'} · 45-sec auto-refresh</span></div><Sparkline points={points}/><div className="detail-facts"><div><span>Pool A liquidity</span><strong>{money(price?.liquidity)}</strong></div><div><span>Pool B liquidity</span><strong>{money(price?.secondLiquidity)}</strong></div></div><p className="detail-disclaimer">Only checks made while this page is open. A pool quote is not a trade price. Market depth and fees can change a fill.</p>{price&&<small className="detail-checked">Last checked {time(price.checked)}{refreshing?' · checking again…':''}</small>}</div>}
    {price?.pool&&<div className="pool-links"><a href={price.pool} target="_blank" rel="noopener noreferrer" aria-label={`Inspect ${a.symbol} Pool A on DexScreener`}>Pool A ↗</a>{price?.secondPool&&<a href={price.secondPool} target="_blank" rel="noopener noreferrer" aria-label={`Inspect ${a.symbol} Pool B on DexScreener`}>Pool B ↗</a>}</div>}
  </article>
}
export function App(){
  const [input,setInput]=useState('');const [address,setAddress]=useState('');const [mode,setMode]=useState<'demo'|'wallet'>('demo');const [holdings,setHoldings]=useState<Holding[]>(DEMO);const [loading,setLoading]=useState(false);const [message,setMessage]=useState('');const [prices,setPrices]=useState<Record<string,Price>>({});const [history,setHistory]=useState<Record<string,Point[]>>({});const [refreshing,setRefreshing]=useState(true);const [tick,setTick]=useState(0);const [lastChecked,setLastChecked]=useState<number>();const [selected,setSelected]=useState('ALL');
  useEffect(()=>{const timer=window.setInterval(()=>{if(document.visibilityState==='visible')setTick(n=>n+1)},POLL_MS);const onVisible=()=>{if(document.visibilityState==='visible')setTick(n=>n+1)};document.addEventListener('visibilitychange',onVisible);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',onVisible)}},[]);
  useEffect(()=>{let cancelled=false;setRefreshing(true);const relevant=assets.filter(a=>holdings.some(h=>h.symbol===a.symbol));if(!relevant.length){setRefreshing(false);return}Promise.all(relevant.map(async a=>[a.symbol,await fetchPrice(a)] as const)).then(rows=>{if(cancelled)return;const now=Date.now();setPrices(Object.fromEntries(rows));setLastChecked(now);setHistory(previous=>{const next={...previous};for(const [symbol,p] of rows){if(p.dex===undefined||p.second===undefined)continue;const point={at:now,gap:(p.dex/p.second-1)*100};const old=next[symbol]||[];next[symbol]=[...old,point].slice(-20)}return next});setRefreshing(false);setMessage(rows.every(([,p])=>p.error)?'Market quotes are temporarily unavailable. Try Refresh prices.':`Live check complete: ${rows.filter(([,p])=>p.dex!==undefined&&p.second!==undefined).length} of ${rows.length} comparisons available.`)}).catch(()=>{if(!cancelled){setRefreshing(false);setMessage('Market data did not answer. Try Refresh prices.')}});return()=>{cancelled=true}},[holdings,tick]);
  const count=useMemo(()=>holdings.filter(h=>prices[h.symbol]?.dex!==undefined&&prices[h.symbol]?.second!==undefined).length,[prices,holdings]);
  async function inspect(e:React.FormEvent){e.preventDefault();const value=input.trim();if(!validSolanaAddress(value)){setMessage('Enter a valid Solana public wallet address (base58, 32 bytes).');return}setLoading(true);setMessage('Checking SPL Token and Token-2022 balances on Solana mainnet…');try{const h=await walletHoldings(value);setAddress(value);setMode('wallet');setSelected('ALL');setHoldings(h);setPrices({});setHistory({});setLastChecked(undefined);setMessage(h.length?'Balances found. Fetching live pool quotes…':'No supported xStocks with a positive balance in this wallet. Try the example.')}catch{setMessage('Wallet lookup is unavailable from this browser right now. Your wallet was not changed; try the example portfolio for live quotes.')}finally{setLoading(false)}}
  function demo(){setMode('demo');setSelected('ALL');setAddress('');setHoldings(DEMO);setPrices({});setHistory({});setLastChecked(undefined);setMessage('Example balances loaded. Fetching live pool quotes…');setTick(n=>n+1)}
  function selectAsset(symbol:string){setSelected(symbol);document.getElementById('compare')?.scrollIntoView({behavior:'smooth',block:'start'})}
  function refresh(){if(refreshing)return;setMessage('Checking live pool quotes…');setTick(n=>n+1)}
  return <FileCard>
    <Header title="Why is my xStock a different price?" fact="A live venue-gap lens for tokenized stocks on Solana" intro="The same token can show two prices at the same moment. See the onchain venue gap, then learn why it happens." />
    <div className="hero"><img className="hero-art" src={previewArt} alt="Abstract overlapping market orbits, an illustration of two price paths"/><div className="hero-motif" aria-hidden="true"><span className="signal one"/><span className="signal two"/><span className="signal three"/><i/><b>≠</b></div><div className="hero-copy"><span className="eyebrow">DOUBLETAKE · EXPLAIN, DON'T TRADE</span><p>One token. Two pools. <em>Which price is real?</em></p></div></div>
    <nav className="journey" aria-label="How to explore DoubleTake"><div><b>01</b><a href="#choose">Pick a stock</a><small>Try the fictional example</small></div><div><b>02</b><a href="#compare">Compare two pools</a><small>Real prices, same token</small></div><div><b>03</b><a href="#explain">Make sense of it</a><small>Know what the gap means</small></div></nav>
    <div id="choose" className="anchor"/>
    <Group label="Start here · 01" heading><p className="journey-intro">Choose a stock below to follow its prices, or load the full example portfolio. It uses made-up balances, but the prices come from live Solana markets. Or inspect a public wallet - no connection or signature needed.</p><p className="lead">Enter a public Solana address to inspect supported xStock balances. Some public RPC endpoints block browser requests, so this may be unavailable; the live market comparison works in example mode.</p><form onSubmit={inspect} className="wallet-form"><label htmlFor="wallet">Public wallet address</label><div className="input-row"><input id="wallet" value={input} onChange={e=>setInput(e.target.value)} spellCheck={false} autoComplete="off" placeholder="Paste a Solana mainnet address"/><button type="submit" disabled={loading}>{loading?'Checking…':'Inspect wallet'}</button></div></form><div className="quick-start"><span className="kicker">One-tap demo · choose an asset</span><div className="quick-buttons">{DEMO.map(h=><button type="button" key={h.symbol} onClick={()=>{if(mode!=='demo'){demo();setTimeout(()=>selectAsset(h.symbol),0)}else selectAsset(h.symbol)}}>{h.symbol}<small>{assets.find(a=>a.symbol===h.symbol)?.name}</small></button>)}</div></div><div className="demo-row"><span>See everything?</span><button type="button" onClick={demo}>Explore example portfolio ↗</button></div>{message&&<p className="status" role="status">{message}</p>}</Group>
    <div id="compare" className="anchor"/><Group label="Compare · 02" heading><p className="journey-intro">One token can have different prices in two trading pools. Pool A and Pool B are the two deepest USDC pools we found. Tap any card to see liquidity and watch the gap change while this tab stays open.</p><div className="section-bar"><span className="mode">{mode==='demo'?'EXAMPLE PORTFOLIO':'LIVE WALLET BALANCES'}</span><button type="button" onClick={refresh} disabled={refreshing} aria-busy={refreshing}>{refreshing?'Checking prices…':'Refresh prices ↻'}</button></div>{mode==='wallet'&&<p className="address">{address}</p>}{holdings.length>1&&<div className="asset-filter" role="group" aria-label="Choose an asset to compare"><button type="button" aria-pressed={selected==='ALL'} onClick={()=>setSelected('ALL')}>All</button>{holdings.map(h=><button type="button" key={h.symbol} aria-pressed={selected===h.symbol} onClick={()=>setSelected(h.symbol)}>{h.symbol}</button>)}</div>}{holdings.length?<><div className="holdings">{holdings.filter(h=>selected==='ALL'||selected===h.symbol).map(h=><Card key={h.symbol} holding={h} price={prices[h.symbol]} points={history[h.symbol]||[]} refreshing={refreshing}/>)}</div><p className="freshness">{lastChecked?`${count}/${holdings.length} paired quotes · Checked ${time(lastChecked)}${refreshing?' · Refreshing…':''}`:'Fetching live quotes…'} · Indicative, not executable prices</p></>:<Callout title="Nothing to compare yet">This wallet has no positive balance among the five currently supported xStocks. Try the example or another public address.</Callout>}</Group>
    <div id="explain" className="anchor"/><Group label="Understand · 03" heading><p className="journey-intro">A gap is the percentage difference between these two pool quotes, not a profit forecast. Open either pool link to check the underlying market yourself.</p><div className="reasons"><div><span>01</span><h3>Different clocks</h3><p>US shares have exchange hours, while Solana pools can trade outside them. A token need not match a closed-market share quote.</p></div><div><span>02</span><h3>Different markets</h3><p>Two Solana USDC pools can post different prices for the same token. This screen compares venues, not a US share price.</p></div><div><span>03</span><h3>Different depth</h3><p>Thin pools, spreads and trade size can move a fill away from a screen quote. Check liquidity before drawing conclusions.</p></div></div></Group>
    <Group label="About this prototype" heading><p className="lead">The example holdings are fictional, but pool prices are fetched live from DexScreener. The gap trail is sampled every 45 seconds while this page is open, held only in memory, and starts fresh on reload. For each verified xStock Solana mint, we compare the two USDC pools with the highest reported USD liquidity above $1,000. Wallet lookup attempts read-only Solana RPC calls for SPL Token and Token-2022; some browsers or public RPCs reject those calls. Five mints are recognized: AAPLx, TSLAx, NVDAx, MSFTx and GOOGLx. Other assets are ignored, not counted as zero.</p><p className="lead">These are DEX pool quotes, not US share prices, issuer indicative values, redemption prices or executable trade prices. Pyth's live price API requires an API key; this prototype does not claim Pyth bounty eligibility.</p><div className="source-links"><a href="https://docs.xstocks.fi/apis/openapi.md" target="_blank" rel="noopener noreferrer">xStocks mint registry ↗</a><a href="https://docs.pyth.network/price-feeds/core/upgrade/preparing" target="_blank" rel="noopener noreferrer">Pyth access note ↗</a><a href="https://solana.com/docs/rpc/http/gettokenaccountsbyowner" target="_blank" rel="noopener noreferrer">Solana RPC ↗</a><a href="https://docs.dexscreener.com/api/reference" target="_blank" rel="noopener noreferrer">DEX market data ↗</a></div></Group>
    <Closing>DoubleTake · Built for the Solana hackathon · Read-only prototype · Live market quotes can be delayed or unavailable; no trades or wallet signatures.</Closing>
  </FileCard>
}
