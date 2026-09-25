const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MINTS=new Set(['XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp','XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB','Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh','XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX','XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN']);
const PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function valid(address) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
  let n=0n; for(const c of address) {const i=ALPHABET.indexOf(c);if(i<0)return false;n=n*58n+BigInt(i)}
  let bytes=0;while(n>0n){bytes++;n>>=8n} return (address.match(/^1*/)?.[0].length||0)+bytes===32;
}
export default async function handler(req,res) {
  if(req.method!=='GET')return res.status(405).json({error:'GET only'});
  const address=String(req.query.address||''); if(!valid(address))return res.status(400).json({error:'Invalid Solana public address'});
  try {
    const all=await Promise.all(PROGRAMS.map(async(programId,i)=>{
      const r=await fetch(RPC,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(12000),body:JSON.stringify({jsonrpc:'2.0',id:i+1,method:'getTokenAccountsByOwner',params:[address,{programId},{encoding:'jsonParsed'}]})});
      if(!r.ok)throw Error(`RPC HTTP ${r.status}`);const d=await r.json();if(d.error)throw Error(d.error.message||'RPC error');return d.result?.value||[];
    }));
    const accounts=all.flat().map(a=>({mint:a.account?.data?.parsed?.info?.mint,amount:a.account?.data?.parsed?.info?.tokenAmount?.uiAmountString})).filter(a=>MINTS.has(a.mint)&&Number(a.amount)>0);
    res.setHeader('Cache-Control','no-store');return res.status(200).json({accounts});
  } catch(e){return res.status(503).json({error:'Wallet balances are unavailable from the RPC. Please retry.',detail:String(e.message||e).slice(0,140)})}
}
