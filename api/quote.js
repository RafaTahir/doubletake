const USDC='EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINTS=['XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp','XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB','Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX','XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN'];
export default async function handler(req,res){
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const mint=String(req.query.mint||''),direction=String(req.query.direction||'buy');
  if(!MINTS.includes(mint)||!['buy','sell'].includes(direction))return res.status(400).json({error:'Invalid asset or direction'});
  // Indicative fixed notional: 10 USDC or 0.01 xStock, both six-decimal mints.
  const inputMint=direction==='buy'?USDC:mint,outputMint=direction==='buy'?mint:USDC,amount=direction==='buy'?'10000000':'10000';
  try {
    const url=new URL('https://lite-api.jup.ag/swap/v1/quote');Object.entries({inputMint,outputMint,amount,slippageBps:'50'}).forEach(([k,v])=>url.searchParams.set(k,v));
    const r=await fetch(url,{signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error(`Jupiter HTTP ${r.status}`);const d=await r.json();if(d.error||!d.outAmount)throw Error(d.error||'No route');
    res.setHeader('Cache-Control','no-store');return res.status(200).json({inputMint,outputMint,inputAmount:Number(amount)/1e6,outputAmount:Number(d.outAmount)/1e6,minOutputAmount:Number(d.otherAmountThreshold)/1e6,priceImpactPct:Number(d.priceImpactPct||0),route:(d.routePlan||[]).map(p=>({venue:p.swapInfo?.label||'Unknown venue',percent:p.percent,feeAmount:p.swapInfo?.feeAmount,feeMint:p.swapInfo?.feeMint})),slippageBps:50,platformFee:d.platformFee||null,quotedAt:Date.now(),source:'Jupiter Lite Swap V1',note:'Indicative only. No transaction is prepared or signed.'});
  }catch(e){return res.status(503).json({error:'Jupiter route unavailable for this pair. No trade attempted.',detail:String(e.message||e).slice(0,140)})}
}
