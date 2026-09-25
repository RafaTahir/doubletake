const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINTS=new Set(['XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp','XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB','Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX','XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN']);
const INPUT=100000000; // $100 USDC; USDC and the five listed xStocks have six decimals.
async function quote(inputMint,outputMint,amount){
 const url=new URL('https://lite-api.jup.ag/swap/v1/quote');Object.entries({inputMint,outputMint,amount:String(amount),slippageBps:'50'}).forEach(([k,v])=>url.searchParams.set(k,v));
 const r=await fetch(url,{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error(`Jupiter HTTP ${r.status}`);const d=await r.json();if(d.error||!d.outAmount)throw Error(d.error||'No quote');return d;
}
export default async function handler(req,res){
 if(req.method!=='GET')return res.status(405).json({error:'GET only'});
 const mint=String(req.query.mint||'');if(!MINTS.has(mint))return res.status(400).json({error:'Unsupported mint'});
 try {
   const buy=await quote(USDC,mint,INPUT),tokens=BigInt(buy.outAmount);
   if(tokens<=0n)throw Error('Buy route has zero output');
   const sell=await quote(mint,USDC,tokens.toString());
   const returned=Number(sell.outAmount)/1e6;
   res.setHeader('Cache-Control','no-store');return res.status(200).json({notionalUsdc:100,buyTokens:Number(buy.outAmount)/1e6,sellUsdc:returned,roundTripDragPct:Math.max(0,(100-returned)),buyRoute:(buy.routePlan||[]).map(p=>p.swapInfo?.label).filter(Boolean),sellRoute:(sell.routePlan||[]).map(p=>p.swapInfo?.label).filter(Boolean),quotedAt:Date.now(),note:'Unrestricted Jupiter round trip. Not pool-specific, not simultaneous, and not executable arbitrage. Fees and price impact are reflected in quoted outputs; network costs and slippage are modeled separately.'});
 }catch(e){return res.status(503).json({error:'Cannot verify two live routes right now. No arbitrage estimate available.',detail:String(e.message||e).slice(0,140)})}
}
