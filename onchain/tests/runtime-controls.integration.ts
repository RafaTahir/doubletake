/** Run explicitly against an offline Surfpool. Never signs on a public cluster. */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Buffer} from 'buffer';
import {Connection,Keypair,PublicKey,TransactionMessage,VersionedTransaction,ComputeBudgetProgram,type TransactionInstruction} from '@solana/web3.js';
import {DEVELOPMENT_PROGRAM_ID,deriveProgramAddresses,buildOwnerInstruction,buildAdminInstruction,decodeVaultState,decodeInvite,calculateMintFingerprint,PROGRAM_ACCOUNT_SIZES,prepareIndependentOwnerAction,validateOwnerTransaction} from '../../shared/program.ts';
import {MARKETS,TOKEN_PROGRAM,USDC} from '../../shared/registry.ts';
import {SolanaChainGateway} from '../../server/chain.ts';
import {RaydiumMarkets} from '../../server/markets.ts';
import {makeIntent} from '../../server/app.ts';
import type {IntentRecord} from '../../server/ports.ts';
const endpoint=process.env.LOCAL_RPC_URL??'http://127.0.0.1:18999';
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(endpoint).hostname))throw new Error('Runtime fixtures may only sign on a loopback test cluster');
const connection=new Connection(endpoint,'confirmed');
const programId=DEVELOPMENT_PROGRAM_ID;
const owner=Keypair.generate(),keeper=Keypair.generate(),attacker=Keypair.generate();
const market=MARKETS.find(m=>m.symbol==='SOL')!;
const addresses=deriveProgramAddresses(programId,owner.publicKey.toBase58(),market.mint);
let id=0;
async function rpc(method:string,params:unknown[]){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});const json=await response.json() as {error?:unknown;result:unknown};if(json.error)throw new Error(`${method}: ${JSON.stringify(json.error)}`);return json.result;}
const disc=(name:string)=>createHash('sha256').update(`account:${name}`).digest().subarray(0,8);
const account=(address:string,data:Buffer,ownerProgram=programId)=>rpc('surfnet_setAccount',[address,{data:data.toString('hex'),owner:ownerProgram,lamports:10_000_000,executable:false}]);
const pk=(value:string)=>new PublicKey(value).toBuffer();
function encodeVault(){
 const data=Buffer.alloc(PROGRAM_ACCOUNT_SIZES.vault);disc('Vault').copy(data);let offset=8;
 for(const value of [owner.publicKey.toBase58(),keeper.publicKey.toBase58(),market.mint,...market.pools]){pk(value).copy(data,offset);offset+=32;}
 for(const value of [1n,100_000_000n,0n,25_000_000n,50_000n,BigInt(Math.floor(Date.now()/1000)+86400),7n,0n,0n]){data.writeBigInt64LE(value,offset);offset+=8;}
 data.writeUInt16LE(0,offset);offset+=2;data[offset++]=0;data[offset++]=1;
 data[offset++]=PublicKey.findProgramAddressSync([Buffer.from('vault'),owner.publicKey.toBuffer()],new PublicKey(programId))[1];
 data.writeBigInt64LE(BigInt(Math.floor(Date.now()/1000)),offset);return data;
}
async function send(action:'deposit'|'withdraw'|'pause'|'close',signer=owner,amountRaw?:string){
 const ix=buildOwnerInstruction({programId,owner:signer.publicKey.toBase58(),action,amountRaw,assetMint:market.mint});
 if(signer===attacker)ix.keys.find(k=>k.pubkey.equals(new PublicKey(deriveProgramAddresses(programId,attacker.publicKey.toBase58()).vault)))!.pubkey=new PublicKey(addresses.vault);
 return sendInstructions([ix],signer);
}
async function sendInstructions(instructions:TransactionInstruction[],signer=owner){
 const blockhash=await connection.getLatestBlockhash();const message=new TransactionMessage({payerKey:signer.publicKey,recentBlockhash:blockhash.blockhash,instructions:[ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...instructions]}).compileToV0Message();
 const tx=new VersionedTransaction(message);tx.sign([signer]);
 const simulated=await connection.simulateTransaction(tx,{sigVerify:true});
 if(simulated.value.err)throw new Error(`Runtime instruction failed: ${JSON.stringify(simulated.value.err)} ${simulated.value.logs?.join('\n')}`);
 const signature=await connection.sendRawTransaction(tx.serialize(),{skipPreflight:false});
 const result=await connection.confirmTransaction({...blockhash,signature},'confirmed');assert.equal(result.value.err,null);return signature;
}
const bytecode=await readFile(new URL('../target/deploy/doubletake.so',import.meta.url));
for(let offset=0;offset<bytecode.length;offset+=200_000){await rpc('surfnet_writeProgram',[programId,bytecode.subarray(offset,offset+200_000).toString('hex'),offset,owner.publicKey.toBase58()]);}
for(const wallet of [owner,attacker])await rpc('surfnet_setAccount',[wallet.publicKey.toBase58(),{lamports:10_000_000_000,owner:'11111111111111111111111111111111',data:''}]);
for(const [mint,decimals] of [[USDC.mint,6],[market.mint,9]] as const){const data=Buffer.alloc(82);data.writeBigUInt64LE(10_000_000_000n,36);data[44]=decimals;data[45]=1;await account(mint,data,TOKEN_PROGRAM);}
await account(addresses.vault,encodeVault());
const invite=Buffer.alloc(PROGRAM_ACCOUNT_SIZES.invite);disc('Invite').copy(invite);owner.publicKey.toBuffer().copy(invite,8);invite[41]=PublicKey.findProgramAddressSync([Buffer.from('invite'),owner.publicKey.toBuffer()],new PublicKey(programId))[1];await account(addresses.invite,invite);
await rpc('surfnet_setTokenAccount',[addresses.vault,USDC.mint,{amount:100_000_000,state:'initialized'},TOKEN_PROGRAM]);
await rpc('surfnet_setTokenAccount',[owner.publicKey.toBase58(),USDC.mint,{amount:0,state:'initialized'},TOKEN_PROGRAM]);
await rpc('surfnet_setTokenAccount',[addresses.vault,market.mint,{amount:0,state:'initialized'},TOKEN_PROGRAM]);
await assert.rejects(()=>send('withdraw',attacker,'1'));
const withdrawal=await send('withdraw',owner,'25000000');
const state=decodeVaultState((await connection.getAccountInfo(new PublicKey(addresses.vault)))!,programId);
assert.equal(state.principalUsdcRaw,'75000000');assert.equal(state.paused,true);assert.equal(state.nonce,'8');assert.equal(state.keeper,PublicKey.default.toBase58());
assert.equal((await connection.getTokenAccountBalance(new PublicKey(addresses.vaultUsdc))).value.amount,'75000000');
assert.equal((await connection.getTokenAccountBalance(new PublicKey(addresses.ownerUsdc))).value.amount,'25000000');
const independent=await prepareIndependentOwnerAction({rpcEndpoint:endpoint,programId,owner:owner.publicKey.toBase58(),action:'withdraw',amountRaw:'75000000',cluster:'localnet'});
validateOwnerTransaction(Buffer.from(independent.unsignedTransactionBase64,'base64'),{programId,owner:owner.publicKey.toBase58(),action:'withdraw',amountRaw:'75000000'});
assert.equal(independent.summary.cluster,'localnet');assert.equal(independent.summary.networkFeeLamports,'5000');
await send('pause');assert.equal(decodeVaultState((await connection.getAccountInfo(new PublicKey(addresses.vault)))!,programId).nonce,'9');
await send('withdraw',owner,'75000000');await send('close');assert.equal(await connection.getAccountInfo(new PublicKey(addresses.vault)),null);
assert.equal(decodeInvite((await connection.getAccountInfo(new PublicKey(addresses.invite)))!,programId).nonceSeed,'11');
// The config was absent for every owner withdrawal/pause/close above. Now prove
// upgrade-authority bootstrap and nonce persistence across actual recreation.
await assert.rejects(()=>sendInstructions([buildAdminInstruction({programId,admin:attacker.publicKey.toBase58(),action:'initialize-config',keeper:keeper.publicKey.toBase58()})],attacker));assert.equal(await connection.getAccountInfo(new PublicKey(addresses.config)),null);
await sendInstructions([buildAdminInstruction({programId,admin:owner.publicKey.toBase58(),action:'initialize-config',keeper:keeper.publicKey.toBase58()})]);
await sendInstructions([buildAdminInstruction({programId,admin:owner.publicKey.toBase58(),action:'set-config',keeper:keeper.publicKey.toBase58(),paused:false}),buildAdminInstruction({programId,admin:owner.publicKey.toBase58(),action:'set-invite',owner:owner.publicKey.toBase58(),enabled:true})]);
const approval=Buffer.alloc(PROGRAM_ACCOUNT_SIZES.asset);disc('AssetConfig').copy(approval);let offset=8;for(const value of[market.mint,...market.pools,TOKEN_PROGRAM]){pk(value).copy(approval,offset);offset+=32;}Buffer.from(await calculateMintFingerprint((await connection.getAccountInfo(new PublicKey(market.mint)))!,Math.floor(Date.now()/1000)),'hex').copy(approval,136);approval.writeBigUInt64LE(1n,168);approval[176]=market.decimals;approval[177]=1;approval[178]=PublicKey.findProgramAddressSync([Buffer.from('asset'),pk(market.mint)],new PublicKey(programId))[1];await account(addresses.assetConfig!,approval);
const reinitialize=await sendInstructions([buildOwnerInstruction({programId,owner:owner.publicKey.toBase58(),action:'initialize',assetMint:market.mint,cycleAmountRaw:'25000000',minProfitRaw:'50000'})]);
const recreated=decodeVaultState((await connection.getAccountInfo(new PublicKey(addresses.vault)))!,programId);assert.equal(recreated.nonce,'11');assert.equal(recreated.paused,true);assert.equal(recreated.principalUsdcRaw,'0');
// Actual system transfers exercise the same gateway receipt proof as production.
// This journal contains public signed messages only; ephemeral private keys never leave memory.
const gateway=new SolanaChainGateway({rpcUrl:endpoint,cluster:'localnet',programId,programVerified:true,expectedUpgradeAuthority:owner.publicKey.toBase58()},new RaydiumMarkets(endpoint,connection));
await gateway.verifyDeployment();assert.equal(gateway.readiness(owner.publicKey.toBase58()).fundingEnabled,true,gateway.readiness().reasons.join('; '));
const feeWallet=Keypair.generate(),feeAddress=feeWallet.publicKey.toBase58(),fundingRaw='1500000';
const journal=await mkdtemp(path.join(tmpdir(),'doubletake-native-fees-'));
async function persistAndConfirm(intent:IntentRecord,signed:{signature:string;wireBase64:string}){
 intent.status='submitted';intent.signature=signed.signature;intent.wireBase64=signed.wireBase64;
 const filename=path.join(journal,`${intent.kind}.json`);await writeFile(filename,JSON.stringify(intent,null,2)+'\n');
 const recorded=JSON.parse(await readFile(filename,'utf8')) as IntentRecord;
 assert.equal(recorded.signature,signed.signature);assert.equal(recorded.prepared.messageBase64,intent.prepared.messageBase64);
 await gateway.broadcastSignedTransaction(recorded.wireBase64!);
 const confirmation=await connection.confirmTransaction({signature:recorded.signature!,blockhash:recorded.blockhash,lastValidBlockHeight:recorded.lastValidBlockHeight},'confirmed');assert.equal(confirmation.value.err,null);
 const receipt=await gateway.reconcile(recorded);assert.equal(receipt.status,'confirmed');assert.ok(receipt.slot);assert.ok(BigInt(receipt.feeLamportsRaw)>0n);return receipt;
}
const ownerBeforeFunding=BigInt(await connection.getBalance(owner.publicKey)),fundingPrepared=await gateway.prepareOwnerAction(owner.publicKey.toBase58(),'fee-funding',{amountRaw:fundingRaw},feeAddress);
const fundingTx=VersionedTransaction.deserialize(Buffer.from(fundingPrepared.transactionBase64,'base64'));fundingTx.sign([owner]);
const fundingSigned=await gateway.verifySignedOwnerTransaction(fundingPrepared,Buffer.from(fundingTx.serialize()).toString('base64'));
const fundingIntent=makeIntent(owner.publicKey.toBase58(),null,'fee-funding',randomUUID(),{amountRaw:fundingRaw},fundingPrepared,feeAddress);
const fundingReceipt=await persistAndConfirm(fundingIntent,fundingSigned);
const ownerAfterFunding=BigInt(await connection.getBalance(owner.publicKey)),creditBalance=BigInt(await gateway.feeWalletBalance(feeAddress));
assert.equal(fundingReceipt.feeFundingRaw,fundingRaw);assert.equal(creditBalance,BigInt(fundingRaw));assert.equal(ownerBeforeFunding-ownerAfterFunding,BigInt(fundingRaw)+BigInt(fundingReceipt.feeLamportsRaw));
const refundFeeQuote=await gateway.prepareRefund(owner.publicKey.toBase58(),feeAddress,'1'),refundRaw=(creditBalance-BigInt(refundFeeQuote.feeLamportsRaw)).toString();
const refundPrepared=await gateway.prepareRefund(owner.publicKey.toBase58(),feeAddress,refundRaw);assert.equal(refundPrepared.feeLamportsRaw,refundFeeQuote.feeLamportsRaw);
const feeSecret=feeWallet.secretKey;let refundSigned:{signature:string;wireBase64:string};try{refundSigned=await gateway.signKeeperTransaction(refundPrepared,feeSecret,owner.publicKey.toBase58());}finally{feeSecret.fill(0);}
const refundIntent=makeIntent(owner.publicKey.toBase58(),null,'fee-refund',randomUUID(),{amountRaw:refundRaw},refundPrepared,feeAddress,refundPrepared.feeLamportsRaw);
const refundReceipt=await persistAndConfirm(refundIntent,refundSigned!),ownerAfterRefund=BigInt(await connection.getBalance(owner.publicKey)),remainingCredit=BigInt(await gateway.feeWalletBalance(feeAddress));
assert.equal(refundReceipt.refundRaw,refundRaw);assert.equal(ownerAfterRefund-ownerAfterFunding,BigInt(refundRaw));assert.equal(creditBalance-BigInt(refundRaw)-remainingCredit,BigInt(refundReceipt.feeLamportsRaw));assert.equal(remainingCredit,0n);assert.ok(BigInt(refundReceipt.feeLamportsRaw)<=50000n);
console.log(JSON.stringify({suite:'offline-sbf-owner-controls',result:'passed',withdrawal,reinitialize,feeFunding:fundingSigned.signature,feeRefund:refundSigned!.signature,feeFundingRaw:fundingReceipt.feeFundingRaw,feeRefundRaw:refundReceipt.refundRaw,actualRefundFeeLamports:refundReceipt.feeLamportsRaw,remainingFeeCreditRaw:remainingCredit.toString(),journal,bytecodeSha256:createHash('sha256').update(bytecode).digest('hex'),checks:['unauthorized-withdrawal','withdraw-without-service-config','withdraw-revokes-keeper','nonce-invalidation','actual-SPL-balances','pause-without-worker','close-with-disabled-invite-and-no-config','durable-nonce-across-close-reinitialize','bootstrap-front-run-rejected','upgrade-authority-bootstrap','actual-native-fee-funding','signed-message-journal-before-broadcast','actual-full-unused-credit-refund','confirmed-network-fee-conservation']},null,2));
