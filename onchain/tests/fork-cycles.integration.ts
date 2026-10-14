/** Exact Raydium swaps against a local Surfpool mainnet fork; NEVER public signing. */
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Buffer} from 'buffer';
import BN from 'bn.js';
import bs58 from 'bs58';
import {Connection,Keypair,PublicKey,TransactionInstruction,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,SYSVAR_CLOCK_PUBKEY,AddressLookupTableProgram,type AddressLookupTableAccount} from '@solana/web3.js';
import {swapInternal,TickArrayUtil,getPdaExBitmapAccount} from '@raydium-io/raydium-sdk-v2';
import {RaydiumMarkets,type LoadedPool} from '../../server/markets.ts';
import {SolanaChainGateway} from '../../server/chain.ts';
import type {Strategy} from '../../shared/types.ts';
import {MARKETS,RAYDIUM_CLMM_PROGRAM,TOKEN_PROGRAM,TOKEN_2022_PROGRAM,USDC} from '../../shared/registry.ts';
import {DEVELOPMENT_PROGRAM_ID,deriveProgramAddresses,deriveAta,buildExecuteInstruction,buildOwnerInstruction,buildAdminInstruction,ownerAtaCreation,decodeVaultState,calculateMintFingerprint,MEMO_PROGRAM,PROGRAM_ACCOUNT_SIZES} from '../../shared/program.ts';
const endpoint=process.env.FORK_RPC_URL??'http://127.0.0.1:19999';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname))throw new Error('Fork fixtures may only sign on a loopback test cluster');
const connection=new Connection(endpoint,'confirmed'),programId=DEVELOPMENT_PROGRAM_ID;
const markets=new RaydiumMarkets(endpoint,connection),market=MARKETS.find(m=>m.symbol===(process.env.FORK_ASSET_SYMBOL??'SOL'));
if(!market)throw new Error('Requested fork asset is not in the approved registry');
const owner=Keypair.generate(),keeper=Keypair.generate(),precreator=Keypair.generate();
const giftedUsdcRaw='2000000',giftedAssetRaw='13',fundedUsdcRaw='102000000';
const a=deriveProgramAddresses(programId,owner.publicKey.toBase58(),market.mint);
let rpcId=0;
async function rpc(method:string,params:unknown[]){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++rpcId,method,params}),signal:AbortSignal.timeout(120000)});const json=await response.json() as {error?:unknown;result:unknown};if(json.error)throw new Error(`${method}: ${JSON.stringify(json.error)}`);return json.result;}
const disc=(prefix:string,name:string)=>createHash('sha256').update(`${prefix}:${name}`).digest().subarray(0,8);
const key=(value:string)=>new PublicKey(value),meta=(value:string|PublicKey,writable=false,signer=false)=>({pubkey:typeof value==='string'?key(value):value,isWritable:writable,isSigner:signer});
const setAccount=(address:string,data:Buffer,ownerProgram=programId)=>rpc('surfnet_setAccount',[address,{data:data.toString('hex'),owner:ownerProgram,lamports:10_000_000,executable:false}]);
async function clock(){const info=await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);return Number(info!.data.readBigInt64LE(32));}
function encodeVault(timestamp:number){const data=Buffer.alloc(PROGRAM_ACCOUNT_SIZES.vault);disc('account','Vault').copy(data);let offset=8;for(const value of [owner.publicKey.toBase58(),keeper.publicKey.toBase58(),market.mint,...market.pools]){key(value).toBuffer().copy(data,offset);offset+=32;}for(const value of [1n,100_000_000n,0n,25_000_000n,50_000n,BigInt(timestamp+86400),1n,0n,0n]){data.writeBigInt64LE(value,offset);offset+=8;}data.writeUInt16LE(0,offset);offset+=2;data[offset++]=0;data[offset++]=0;data[offset++]=PublicKey.findProgramAddressSync([Buffer.from('vault'),owner.publicKey.toBuffer()],key(programId))[1];data.writeBigInt64LE(BigInt(timestamp),offset);return data;}
const balance=async(address:string)=>(await connection.getTokenAccountBalance(key(address))).value.amount;
let lookup:AddressLookupTableAccount|undefined;
const signed=async(instructions:TransactionInstruction[],signer:Keypair)=>{const blockhash=await connection.getLatestBlockhash();const tx=new VersionedTransaction(new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:blockhash.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:1_200_000}),...instructions]}).compileToV0Message(lookup?[lookup]:[]));tx.sign([signer]);return{tx,blockhash};};
async function send(instructions:TransactionInstruction[],signer:Keypair){const {tx,blockhash}=await signed(instructions,signer);const simulated=await connection.simulateTransaction(tx,{sigVerify:true});if(simulated.value.err)throw new Error(`Fork simulation failed ${JSON.stringify(simulated.value.err)}\n${simulated.value.logs?.join('\n')}`);const signature=await connection.sendRawTransaction(tx.serialize());const confirmed=await connection.confirmTransaction({...blockhash,signature},'confirmed');assert.equal(confirmed.value.err,null);return{signature,units:simulated.value.unitsConsumed};}
function directSwap(pool:LoadedPool,amount:string){
 const zeroForOne=pool.state.mintA.toBase58()===USDC.mint,start=TickArrayUtil.getTickArrayStartIndex(pool.state.tickCurrent,pool.state.tickSpacing);
 const ticks=pool.ticks.filter(t=>zeroForOne?t.value.startTickIndex<=start:t.value.startTickIndex>=start).sort((x,y)=>zeroForOne?y.value.startTickIndex-x.value.startTickIndex:x.value.startTickIndex-y.value.startTickIndex);
 const quote=swapInternal({programId:key(RAYDIUM_CLMM_PROGRAM),poolId:pool.id,poolInfo:pool.state,configInfo:pool.config,tickarrayBitmapExtension:pool.bitmap,tickArrays:ticks,amountSpecified:new BN(amount),sqrtPriceLimitX64:new BN(0),zeroForOne,isBaseInput:true,blockTimestamp:pool.clock,includeExtraTickArrays:true});
 if(!quote.allTrade||!quote.amountSpecifiedRemaining.isZero())throw new Error('Fixture push trade exceeds cloned tick depth');
 const data=Buffer.alloc(41);disc('global','swap_v2').copy(data);data.writeBigUInt64LE(BigInt(amount),8);data.writeBigUInt64LE(1n,16);data[40]=1;
 const usdc=zeroForOne?pool.state.vaultA:pool.state.vaultB,asset=zeroForOne?pool.state.vaultB:pool.state.vaultA;
 return new TransactionInstruction({programId:key(RAYDIUM_CLMM_PROGRAM),data,keys:[meta(owner.publicKey,false,true),meta(pool.state.configId),meta(pool.id,true),meta(deriveAta(owner.publicKey.toBase58(),USDC.mint),true),meta(deriveAta(owner.publicKey.toBase58(),market.mint,market.tokenProgram),true),meta(usdc,true),meta(asset,true),meta(pool.state.observationId,true),meta(TOKEN_PROGRAM),meta(TOKEN_2022_PROGRAM),meta(MEMO_PROGRAM),meta(USDC.mint),meta(market.mint),...(pool.bitmapExists?[meta(getPdaExBitmapAccount(key(RAYDIUM_CLMM_PROGRAM),pool.id).publicKey,true)]:[]),...quote.accounts.map(p=>meta(p,true))]});
}
const bytecode=await readFile(new URL('../target/deploy/doubletake.so',import.meta.url));
for(let offset=0;offset<bytecode.length;offset+=200000)await rpc('surfnet_writeProgram',[programId,bytecode.subarray(offset,offset+200000).toString('hex'),offset,owner.publicKey.toBase58()]);
for(const [signer,lamports]of[[owner,10_000_000_000],[keeper,5_000_000],[precreator,10_000_000_000]]as const)await rpc('surfnet_setAccount',[signer.publicKey.toBase58(),{lamports,owner:'11111111111111111111111111111111',data:''}]);
// Surfpool lazily clones the actual Raydium program and pool accounts here.
let pools=await markets.loadExactPools(market,market.pools);await connection.getAccountInfo(key(RAYDIUM_CLMM_PROGRAM));
await rpc('surfnet_setTokenAccount',[owner.publicKey.toBase58(),USDC.mint,{amount:5_000_000_000_000,state:'initialized'},TOKEN_PROGRAM]);
await rpc('surfnet_setTokenAccount',[owner.publicKey.toBase58(),market.mint,{amount:0,state:'initialized'},market.tokenProgram]);
const pushes=[];
const pushAmounts=process.env.FORK_PUSH_AMOUNTS?.split(',')??(market.category==='xstock'?['100000000','500000000',...Array<string>(30).fill('1000000000')]:['5000000000','50000000000','500000000000']);
for(const amount of pushAmounts){
 pushes.push(await send([directSwap(pools[0],amount)],owner));
 const policy={assetMint:market.mint,poolBuy:market.pools[1],poolSell:market.pools[0],cycleAmountRaw:'25000000',minProfitRaw:'50000',dailyFeeLimitLamports:'500000',maxFeePerAttemptLamports:'50000',maxCyclesPerDay:10,cooldownSeconds:60,expiresAt:new Date(Date.now()+86400000).toISOString(),slippageBps:0};
 const q=await markets.quoteCycle(policy);console.log(JSON.stringify({fixturePush:amount,asset:market.symbol,quotedProfitRaw:q.profitRaw}));if(BigInt(q.profitRaw)>=(market.category==='xstock'?75000n:50000n))break;
 pools=await markets.loadExactPools(market,market.pools);
}
const now=await clock();
const config=Buffer.alloc(75);disc('account','ServiceConfig').copy(config);owner.publicKey.toBuffer().copy(config,8);keeper.publicKey.toBuffer().copy(config,40);config[72]=0;config[73]=1;config[74]=PublicKey.findProgramAddressSync([Buffer.from('config')],key(programId))[1];await setAccount(a.config,config);
const invite=Buffer.alloc(PROGRAM_ACCOUNT_SIZES.invite);disc('account','Invite').copy(invite);owner.publicKey.toBuffer().copy(invite,8);invite[40]=1;invite[41]=PublicKey.findProgramAddressSync([Buffer.from('invite'),owner.publicKey.toBuffer()],key(programId))[1];await setAccount(a.invite,invite);
const mint=await connection.getAccountInfo(key(market.mint));const fingerprint=await calculateMintFingerprint(mint!,now);
const approval=Buffer.alloc(179);disc('account','AssetConfig').copy(approval);let offset=8;for(const value of[market.mint,...market.pools,market.tokenProgram]){key(value).toBuffer().copy(approval,offset);offset+=32;}Buffer.from(fingerprint,'hex').copy(approval,136);approval.writeBigUInt64LE(1n,168);approval[176]=market.decimals;approval[177]=1;approval[178]=PublicKey.findProgramAddressSync([Buffer.from('asset'),key(market.mint).toBuffer()],key(programId))[1];await setAccount(a.assetConfig!,approval);
// Actual owner instructions create canonical ATAs, transfer principal and authorize
// this user's keeper. Only administrative admission records are local fixtures.
// An unrelated payer can create off-curve vault ATAs before the vault exists.
const precreated=[ownerAtaCreation(a.vault,USDC.mint),ownerAtaCreation(a.vault,market.mint,market.tokenProgram)];for(const ix of precreated)ix.keys[0]=meta(precreator.publicKey,true,true);
const precreation=await send(precreated,precreator);
const gift=(mint:string,program:string,decimals:number,amount:string)=>{const data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(BigInt(amount),1);data[9]=decimals;return new TransactionInstruction({programId:key(program),data,keys:[meta(deriveAta(owner.publicKey.toBase58(),mint,program),true),meta(mint),meta(deriveAta(a.vault,mint,program),true),meta(owner.publicKey,false,true)]});};
await send([gift(USDC.mint,TOKEN_PROGRAM,6,giftedUsdcRaw),gift(market.mint,market.tokenProgram,market.decimals,giftedAssetRaw)],owner);
const initialize=await send([buildOwnerInstruction({programId,owner:owner.publicKey.toBase58(),action:'initialize',assetMint:market.mint,cycleAmountRaw:'25000000',minProfitRaw:'50000'})],owner);
const initial=decodeVaultState((await connection.getAccountInfo(key(a.vault)))!,programId);assert.equal(initial.paused,true);assert.equal(initial.nonce,'0');assert.equal(initial.principalUsdcRaw,'0');assert.equal(await balance(a.vaultUsdc),giftedUsdcRaw);assert.equal(await balance(a.vaultAsset!),giftedAssetRaw);
const deposit=await send([buildOwnerInstruction({programId,owner:owner.publicKey.toBase58(),action:'deposit',amountRaw:'100000000'})],owner);
const overCap=await signed([buildOwnerInstruction({programId,owner:owner.publicKey.toBase58(),action:'deposit',amountRaw:'1'})],owner);const overCapResult=await connection.simulateTransaction(overCap.tx,{sigVerify:true});assert.ok(overCapResult.value.err);assert.ok(overCapResult.value.logs?.some(log=>log.includes('DepositCap')));assert.equal(await balance(a.vaultUsdc),fundedUsdcRaw);
const authorizeAt=await clock();
const configure=await send([buildOwnerInstruction({programId,owner:owner.publicKey.toBase58(),action:'configure',assetMint:market.mint,keeper:keeper.publicKey.toBase58(),cycleAmountRaw:'25000000',minProfitRaw:'50000',expiresAt:authorizeAt+86300,nowSeconds:authorizeAt,enabled:true,buyPoolFirst:false})],owner);
const authorized=decodeVaultState((await connection.getAccountInfo(key(a.vault)))!,programId);assert.equal(authorized.paused,false);assert.equal(authorized.keeper,keeper.publicKey.toBase58());assert.equal(authorized.nonce,'2');assert.equal(authorized.principalUsdcRaw,'100000000');
// Subsequent replay/cooldown cases intentionally begin at a known local nonce.
await setAccount(a.vault,encodeVault(await clock()));
const policy={assetMint:market.mint,poolBuy:market.pools[1],poolSell:market.pools[0],cycleAmountRaw:'25000000',minProfitRaw:'50000',dailyFeeLimitLamports:'500000',maxFeePerAttemptLamports:'50000',maxCyclesPerDay:10,cooldownSeconds:60,expiresAt:new Date((now+86400)*1000).toISOString(),slippageBps:0};
const quote=await markets.quoteCycle(policy);assert.ok(BigInt(quote.profitRaw)>=50000n,'Fixture must have an actual positive exact-pool quote');
const pool=(p:LoadedPool,ticks:PublicKey[])=>({pool:p.id.toBase58(),config:p.state.configId.toBase58(),usdcVault:(p.state.mintA.toBase58()===USDC.mint?p.state.vaultA:p.state.vaultB).toBase58(),assetVault:(p.state.mintA.toBase58()===USDC.mint?p.state.vaultB:p.state.vaultA).toBase58(),observation:p.state.observationId.toBase58(),tickAccounts:[...(p.bitmapExists?[getPdaExBitmapAccount(key(RAYDIUM_CLMM_PROGRAM),p.id).publicKey.toBase58()]:[]),...ticks.map(t=>t.toBase58())]});
const make=async(nonce:string,sellMin='25050000')=>buildExecuteInstruction({programId,owner:owner.publicKey.toBase58(),keeper:keeper.publicKey.toBase58(),assetMint:market.mint,nonce,deadlineSlot:String(await connection.getSlot('processed')+30),buyMinimumOutRaw:quote.buyMinOutRaw,sellMinimumOutRaw:sellMin,buyPoolFirst:false,poolA:pool(quote.sell,quote.sellTicks),poolB:pool(quote.buy,quote.buyTicks)});
// Use a real local Address Lookup Table, exactly as the production v0 builder requires.
const [createLookup,lookupAddress]=AddressLookupTableProgram.createLookupTable({authority:owner.publicKey,payer:owner.publicKey,recentSlot:await connection.getSlot()});
await send([createLookup],owner);
const executionAccounts=[...new Map((await make('1')).keys.filter(k=>!k.isSigner).map(k=>[k.pubkey.toBase58(),k.pubkey])).values()];
for(let offset=0;offset<executionAccounts.length;offset+=20)await send([AddressLookupTableProgram.extendLookupTable({authority:owner.publicKey,payer:owner.publicKey,lookupTable:lookupAddress,addresses:executionAccounts.slice(offset,offset+20)})],owner);
await new Promise(resolve=>setTimeout(resolve,1600));
lookup=(await connection.getAddressLookupTable(lookupAddress)).value??undefined;assert.ok(lookup,'A confirmed local lookup table is required');
if(lookup.state.lastExtendedSlot>=await connection.getSlot('processed'))throw new Error('The local lookup table is not active yet');
async function rejection(label:string,expectedLog:string){const tx=await signed([await make('1')],keeper);const result=await connection.simulateTransaction(tx.tx,{sigVerify:true});assert.ok(result.value.err,`${label} must reject`);assert.ok(result.value.logs?.some(log=>log.includes(expectedLog)),`${label}: ${JSON.stringify(result.value)}`);assert.equal(await balance(a.vaultUsdc),fundedUsdcRaw);assert.equal(await balance(a.vaultAsset!),giftedAssetRaw);}
const assetAccount=(await connection.getAccountInfo(key(a.vaultAsset!)))!;
const frozen=Buffer.from(assetAccount.data);frozen[108]=2;
await setAccount(a.vaultAsset!,frozen,market.tokenProgram);try{await rejection('frozen intermediate account','FrozenAccount');}finally{await setAccount(a.vaultAsset!,assetAccount.data,market.tokenProgram);}
const missingTick=quote.buyTicks[0];assert.ok(missingTick,'A real required tick array is needed');const tickAccount=(await connection.getAccountInfo(missingTick))!;
await setAccount(missingTick.toBase58(),Buffer.alloc(0),'11111111111111111111111111111111');try{await rejection('missing tick array','InvalidTickArray');}finally{await setAccount(missingTick.toBase58(),tickAccount.data,tickAccount.owner.toBase58());}
if(market.tokenProgram===TOKEN_2022_PROGRAM){
 const original=(await connection.getAccountInfo(key(market.mint)))!;const changing=Buffer.from(original.data);let tlv=166,scaled=-1;
 while(tlv+4<=changing.length){const kind=changing.readUInt16LE(tlv),size=changing.readUInt16LE(tlv+2);if(kind===25){scaled=tlv+4;break;}tlv+=4+size;}
 assert.ok(scaled>=0,'xStock must expose a scaled UI amount extension');changing.writeBigInt64LE(BigInt(await clock()+300),scaled+40);
 await setAccount(market.mint,changing,market.tokenProgram);try{await rejection('scheduled multiplier activation','MultiplierActivation');}finally{await setAccount(market.mint,original.data,market.tokenProgram);}
}
// Reverse the same two exact pools. Both native swaps must be attempted, and the
// real negative quote must not become an executable or partially committed loss.
const losingQuote=await markets.quoteCycle({...policy,poolBuy:market.pools[0],poolSell:market.pools[1]});
assert.ok(BigInt(losingQuote.profitRaw)<0n,'Reversed controlled-gap fixture must quote a real loss');
const savedVault=(await connection.getAccountInfo(key(a.vault)))!,reverseVault=Buffer.from(savedVault.data);reverseVault[243]=1;
const losingPoolsBefore=await connection.getMultipleAccountsInfo(market.pools.map(key)),losingFeeBefore=await connection.getBalance(keeper.publicKey);
let losingSignature='',losingFeeLamports='0';
await setAccount(a.vault,reverseVault);
try{
 const losingInstruction=buildExecuteInstruction({programId,owner:owner.publicKey.toBase58(),keeper:keeper.publicKey.toBase58(),assetMint:market.mint,nonce:'1',deadlineSlot:String(await connection.getSlot('processed')+30),buyMinimumOutRaw:'1',sellMinimumOutRaw:'25050000',buyPoolFirst:true,poolA:pool(losingQuote.buy,losingQuote.buyTicks),poolB:pool(losingQuote.sell,losingQuote.sellTicks)});
 const losing=await signed([losingInstruction],keeper);losingSignature=bs58.encode(losing.tx.signatures[0]);const simulated=await connection.simulateTransaction(losing.tx,{sigVerify:true});
 assert.ok(simulated.value.err,'An actual losing route must fail the guarded USDC minimum');
 assert.ok((simulated.value.logs??[]).filter(line=>line.includes('Instruction: SwapV2')).length>=2,'Losing route must invoke both actual Raydium CPIs');
 try{await connection.sendRawTransaction(losing.tx.serialize(),{skipPreflight:true});}catch{/* A processed local SVM failure may be returned synchronously. */}
 assert.equal(await balance(a.vaultUsdc),fundedUsdcRaw);assert.equal(await balance(a.vaultAsset!),giftedAssetRaw);assert.equal(decodeVaultState((await connection.getAccountInfo(key(a.vault)))!,programId).nonce,'1');
 const unchanged=await connection.getMultipleAccountsInfo(market.pools.map(key));for(let i=0;i<unchanged.length;i++)assert.ok(unchanged[i]!.data.equals(losingPoolsBefore[i]!.data),'Losing route must revert both pool states');
 losingFeeLamports=String(losingFeeBefore-await connection.getBalance(keeper.publicKey));assert.ok(BigInt(losingFeeLamports)>0n,'Confirmed failed losing route still charges network fees');
}finally{await setAccount(a.vault,savedVault.data);}
// Second leg intentionally rejects its received output. First-leg and pool state must revert.
const before=await balance(a.vaultUsdc),assetBefore=await balance(a.vaultAsset!);const keeperBefore=await connection.getBalance(keeper.publicKey);
const poolsBefore=await connection.getMultipleAccountsInfo(market.pools.map(key));
const failing=await signed([await make('1','18446744073709551615')],keeper);const failedSignature=bs58.encode(failing.tx.signatures[0]);
const failureSimulation=await connection.simulateTransaction(failing.tx,{sigVerify:true});
assert.ok(failureSimulation.value.err,'Second leg must reject the excessive minimum output');
assert.ok((failureSimulation.value.logs??[]).filter(line=>line.includes('Instruction: SwapV2')).length>=2,`Failure must occur after both real Raydium CPIs are invoked: ${JSON.stringify(failureSimulation.value)}`);
try{await connection.sendRawTransaction(failing.tx.serialize(),{skipPreflight:true});}catch{/* Surfpool can return the processed SVM failure synchronously. */}
assert.equal(await balance(a.vaultUsdc),before);assert.equal(await balance(a.vaultAsset!),assetBefore);
const poolsAfterFailure=await connection.getMultipleAccountsInfo(market.pools.map(key));
for(let i=0;i<poolsBefore.length;i++)assert.ok(poolsBefore[i]!.data.equals(poolsAfterFailure[i]!.data),'Failed cycle must revert both pool states');
const keeperAfterFailure=await connection.getBalance(keeper.publicKey);assert.ok(keeperAfterFailure<keeperBefore,'A processed failed cycle still charges network fees');
assert.equal(decodeVaultState((await connection.getAccountInfo(key(a.vault)))!,programId).nonce,'1');
const success=await send([await make('1')],keeper);const after=await balance(a.vaultUsdc);assert.ok(BigInt(after)>=BigInt(before)+50000n);assert.equal(await balance(a.vaultAsset!),assetBefore);
const state=decodeVaultState((await connection.getAccountInfo(key(a.vault)))!,programId);assert.equal(state.nonce,'2');assert.equal(state.dailyCycles,1);assert.equal(state.accountedProfitUsdcRaw,(BigInt(after)-BigInt(before)).toString());
const replay=await signed([await make('1')],keeper);assert.ok((await connection.simulateTransaction(replay.tx,{sigVerify:true})).value.err);
const keeperAfter=await connection.getBalance(keeper.publicKey);assert.ok(keeperAfter<keeperBefore);
// Exercise the actual product transaction service after the direct program checks.
// Reset permissions/cooldown only in this local fixture; no production state changes.
await setAccount(a.vault,encodeVault(await clock()));
const gateway=new SolanaChainGateway({rpcUrl:endpoint,cluster:'localnet',programId,programVerified:true,keeperEnabled:true,lookupTable:lookupAddress.toBase58()},markets);
await gateway.verifyDeployment();assert.equal(gateway.readiness(owner.publicKey.toBase58()).fundingEnabled,true);
const strategy:Strategy={id:`fixture-${market.symbol}`,owner:owner.publicKey.toBase58(),vaultAddress:a.vault,keeperAddress:keeper.publicKey.toBase58(),policy:{...policy,expiresAt:new Date((await clock()+86400)*1000).toISOString()},status:'active',pauseReason:null,balanceUsdcRaw:await balance(a.vaultUsdc),depositedPrincipalRaw:'100000000',nonce:'1',confirmedCyclesToday:0,consecutiveFailures:0,chainSlot:await connection.getSlot('processed'),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const preview=await gateway.executionPreview(strategy);assert.equal(preview.status,'ready',JSON.stringify(preview));assert.equal(preview.simulation?.success,true);
const prepared=await gateway.prepareExecution(strategy,preview,keeper.publicKey.toBase58());
const reviewed=await gateway.signKeeperTransaction(prepared,keeper.secretKey,owner.publicKey.toBase58());
const serviceUsdcBefore=BigInt(await balance(a.vaultUsdc)),serviceFeeBefore=BigInt(await gateway.feeWalletBalance(keeper.publicKey.toBase58()));
const serviceSignature=await gateway.broadcastSignedTransaction(reviewed.wireBase64);assert.equal(serviceSignature,reviewed.signature);
const serviceConfirmation=await connection.confirmTransaction({signature:serviceSignature,blockhash:prepared.blockhash,lastValidBlockHeight:prepared.lastValidBlockHeight},'confirmed');assert.equal(serviceConfirmation.value.err,null);
const reconciled=await gateway.reconcile({signature:serviceSignature,lastValidBlockHeight:prepared.lastValidBlockHeight,feePayer:keeper.publicKey.toBase58(),prepared,owner:owner.publicKey.toBase58(),strategyId:strategy.id,payload:{policy:strategy.policy},kind:'execute',feeWallet:keeper.publicKey.toBase58()});
assert.equal(reconciled.status,'confirmed',JSON.stringify(reconciled));assert.ok(BigInt(reconciled.usdcDeltaRaw!)>=50000n);assert.equal(BigInt(await balance(a.vaultUsdc))-serviceUsdcBefore,BigInt(reconciled.usdcDeltaRaw!));assert.equal(serviceFeeBefore-BigInt(await gateway.feeWalletBalance(keeper.publicKey.toBase58())),BigInt(reconciled.feeLamportsRaw));assert.equal(await balance(a.vaultAsset!),giftedAssetRaw);
assert.match(reconciled.mintFingerprint??'',/^[0-9a-f]{64}$/);assert.equal(reconciled.mintFingerprint,fingerprint);assert.ok(BigInt(reconciled.assetReceivedRaw??'0')>0n,'Actual guarded event must record a received raw token quantity');
// Service/admission pauses must not trap principal or gifts in either account.
await send([buildAdminInstruction({programId,admin:owner.publicKey.toBase58(),action:'set-config',keeper:keeper.publicKey.toBase58(),paused:true}),buildAdminInstruction({programId,admin:owner.publicKey.toBase58(),action:'set-invite',owner:owner.publicKey.toBase58(),enabled:false})],owner);
const withdrawAmount=await balance(a.vaultUsdc),ownerUsdcBefore=BigInt(await balance(a.ownerUsdc));
const withdraw=await send([buildOwnerInstruction({programId,owner:owner.publicKey.toBase58(),action:'withdraw',amountRaw:withdrawAmount})],owner);assert.equal(await balance(a.vaultUsdc),'0');assert.equal(BigInt(await balance(a.ownerUsdc))-ownerUsdcBefore,BigInt(withdrawAmount));
const ownerAssetBefore=BigInt(await balance(a.ownerAsset!));const recover=await send([buildOwnerInstruction({programId,owner:owner.publicKey.toBase58(),action:'recover',assetMint:market.mint,amountRaw:giftedAssetRaw})],owner);assert.equal(await balance(a.vaultAsset!),'0');assert.equal(BigInt(await balance(a.ownerAsset!))-ownerAssetBefore,BigInt(giftedAssetRaw));
const recovered=decodeVaultState((await connection.getAccountInfo(key(a.vault)))!,programId);assert.equal(recovered.principalUsdcRaw,'0');assert.equal(recovered.accountedProfitUsdcRaw,'0');assert.equal(recovered.paused,true);assert.equal(recovered.keeper,PublicKey.default.toBase58());
await mkdir(new URL('../fixtures/generated/',import.meta.url),{recursive:true});
const snapshot=await rpc('surfnet_exportSnapshot',[{scope:{preTransaction:success.signature},filter:{excludeSysvars:false,excludeFeatureGates:true}}]);await writeFile(new URL(`../fixtures/generated/positive-${market.symbol.toLowerCase()}-cycle.json`,import.meta.url),JSON.stringify((snapshot as {value?:unknown}).value??snapshot));
const evidence={
 suite:'forked-mainnet-atomic-raydium-cycles',result:'passed',asset:market.symbol,tokenProgram:market.tokenProgram,
 cluster:'local-Surfpool-mainnet-fork',programSha256:createHash('sha256').update(bytecode).digest('hex'),
 pushes,ownerActions:{precreation,initialize,deposit,configure,withdraw,recover},success,failedSignature,
 losingRoute:{quotedProfitRaw:losingQuote.profitRaw,signature:losingSignature,chargedLamports:losingFeeLamports,allPoolAndTokenStateReverted:true},
 usdcStart:before,usdcEnd:after,confirmedProfitRaw:(BigInt(after)-BigInt(before)).toString(),chargedLamports:String(keeperBefore-keeperAfter),
 gateway:{preview:preview.status,signature:serviceSignature,usdcDeltaRaw:reconciled.usdcDeltaRaw,feeLamportsRaw:reconciled.feeLamportsRaw,unitsConsumed:preview.simulation?.unitsConsumed,mintFingerprint:reconciled.mintFingerprint,assetReceivedRaw:reconciled.assetReceivedRaw,multiplier:prepared.summary.multiplier??null,multiplierEffectiveAt:prepared.summary.multiplierEffectiveAt??reconciled.multiplierEffectiveAt??null},
 checks:['actual-mainnet-Raydiumpools','precreated-vault-ATAs-and-gifts-retained','real-owner-initialize-deposit-configure','real-deposit-cap-rejected','actual-token-output-handoff','profitable-cycle','negative-quoted-reverse-route-atomic-revert','failing-second-leg-rollback','nonce-replay-rejected','zero-new-inventory','confirmed-profit-ledger','frozen-account-rejected','missing-tick-rejected','real-gateway-full-simulation','real-gateway-keeper-signing','real-gateway-receipt-reconciliation','real-gateway-fee-accounting','guarded-event-mint-fingerprint-and-actual-received-amount','withdraw-and-recover-gifts-during-service-and-invite-pause',...(market.tokenProgram===TOKEN_2022_PROGRAM?['scheduled-multiplier-rejected']:[])],
};
await writeFile(new URL(`../fixtures/generated/verification-${market.symbol.toLowerCase()}.json`,import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
