import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'buffer';
import {Keypair,PublicKey,SystemProgram,TransactionMessage,VersionedTransaction,ComputeBudgetProgram} from '@solana/web3.js';
import {buildOwnerInstruction,buildAdminInstruction,validateOwnerTransaction,deriveProgramAddresses,derivePda,UPGRADEABLE_LOADER_PROGRAM,DEVELOPMENT_PROGRAM_ID,decodeVaultState,PROGRAM_ACCOUNT_SIZES,buildExecuteInstruction,ownerAtaCreation} from '../../shared/program.ts';
import {MARKETS,USDC} from '../../shared/registry.ts';
const owner=Keypair.generate().publicKey.toBase58(),keeper=Keypair.generate().publicKey.toBase58(),programId=DEVELOPMENT_PROGRAM_ID;
const blockhash=Keypair.generate().publicKey.toBase58();
const unsigned=(instructions:any[])=>new VersionedTransaction(new TransactionMessage({payerKey:new PublicKey(owner),recentBlockhash:blockhash,instructions}).compileToV0Message()).serialize();
test('owner deposit instruction is canonical and independently reconstructed',()=>{
 const ix=buildOwnerInstruction({programId,owner,action:'deposit',amountRaw:'10000000'});
 assert.doesNotThrow(()=>validateOwnerTransaction(unsigned([ix]),{programId,owner,action:'deposit',amountRaw:'10000000'}));
 assert.throws(()=>validateOwnerTransaction(unsigned([ix]),{programId,owner,action:'deposit',amountRaw:'9999999'}));
 const recipient=ix.keys[5];recipient.pubkey=Keypair.generate().publicKey;
 assert.throws(()=>validateOwnerTransaction(unsigned([ix]),{programId,owner,action:'deposit',amountRaw:'10000000'}));
});
test('withdraw accepts only the owner canonical USDC ATA and one owner action',()=>{
 const ix=buildOwnerInstruction({programId,owner,action:'withdraw',amountRaw:'10000000'});
 assert.doesNotThrow(()=>validateOwnerTransaction(unsigned([ownerAtaCreation(owner,USDC.mint),ix]),{programId,owner,action:'withdraw',amountRaw:'10000000'}));
 const theft=SystemProgram.transfer({fromPubkey:new PublicKey(owner),toPubkey:Keypair.generate().publicKey,lamports:1});
 assert.throws(()=>validateOwnerTransaction(unsigned([ix,theft]),{programId,owner,action:'withdraw',amountRaw:'10000000'}));
});
test('unsupported amounts and permissions are rejected before wallet prompt',()=>{
 assert.throws(()=>buildOwnerInstruction({programId,owner,action:'deposit',amountRaw:'100000001'}));
 assert.throws(()=>buildOwnerInstruction({programId,owner,action:'initialize',assetMint:MARKETS[0].mint,cycleAmountRaw:'25000001',minProfitRaw:'50000'}));
 assert.throws(()=>buildOwnerInstruction({programId,owner,action:'configure',assetMint:MARKETS[0].mint,cycleAmountRaw:'25000000',minProfitRaw:'49999',keeper,enabled:true,expiresAt:200,nowSeconds:100}));
 assert.throws(()=>buildOwnerInstruction({programId,owner,action:'configure',assetMint:MARKETS[0].mint,cycleAmountRaw:'25000000',minProfitRaw:'50000',keeper,enabled:true,expiresAt:86501,nowSeconds:100}));
});
test('network fee limit and fee-wallet recipient are independently checked',()=>{
 const ix=buildOwnerInstruction({programId,owner,action:'pause'});
 assert.doesNotThrow(()=>validateOwnerTransaction(unsigned([ComputeBudgetProgram.setComputeUnitLimit({units:400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:10000}),ix]),{programId,owner,action:'pause'}));
 assert.throws(()=>validateOwnerTransaction(unsigned([ComputeBudgetProgram.setComputeUnitLimit({units:1400000}),ComputeBudgetProgram.setComputeUnitPrice({microLamports:1000000}),ix]),{programId,owner,action:'pause'}));
 const transfer=SystemProgram.transfer({fromPubkey:new PublicKey(owner),toPubkey:new PublicKey(keeper),lamports:1000000});
 assert.doesNotThrow(()=>validateOwnerTransaction(unsigned([transfer]),{programId,owner,action:'fee-funding',feeWallet:keeper,amountRaw:'1000000'}));
 assert.throws(()=>validateOwnerTransaction(unsigned([transfer]),{programId,owner,action:'fee-funding',feeWallet:owner,amountRaw:'1000000'}));
});
test('per-owner vault PDA and strict account ownership/type decoding',()=>{
 const address=deriveProgramAddresses(programId,owner,MARKETS[0].mint);
 assert.notEqual(address.vault,deriveProgramAddresses(programId,keeper,MARKETS[0].mint).vault);
 const data=Buffer.alloc(PROGRAM_ACCOUNT_SIZES.vault);Buffer.from([211,8,232,43,2,152,117,119]).copy(data);
 new PublicKey(owner).toBuffer().copy(data,8);
 const info={data,owner:new PublicKey(programId),lamports:100000,executable:false,rentEpoch:0};
 assert.equal(decodeVaultState(info,programId).owner,owner);
 assert.throws(()=>decodeVaultState({...info,owner:new PublicKey(keeper)},programId));
 assert.throws(()=>decodeVaultState({...info,data:Buffer.alloc(253)},programId));
});
test('keeper client restricts execution to approved pool pair',()=>{
 const market=MARKETS[0],account=(pool:string)=>({pool,config:keeper,usdcVault:owner,assetVault:keeper,observation:owner,tickAccounts:[keeper]});
 const input={programId,owner,keeper,assetMint:market.mint,nonce:'1',deadlineSlot:'1234',buyMinimumOutRaw:'1',sellMinimumOutRaw:'25050000',buyPoolFirst:true,poolA:account(market.pools[0]),poolB:account(market.pools[1])};
 assert.equal(buildExecuteInstruction(input).data.length,41);
 assert.throws(()=>buildExecuteInstruction({...input,poolA:account(owner)}));
});
test('operator bootstrap proves canonical ProgramData and starts with a separate default keeper',()=>{
 const ix=buildAdminInstruction({programId,admin:owner,action:'initialize-config',keeper});
 assert.equal(ix.keys[0].isSigner,true);assert.equal(ix.keys[0].isWritable,true);
 assert.equal(ix.keys[2].pubkey.toBase58(),derivePda(UPGRADEABLE_LOADER_PROGRAM,[new PublicKey(programId).toBytes()]));
 assert.equal(ix.data.length,40);assert.equal(new PublicKey(ix.data.subarray(8)).toBase58(),keeper);
 const pause=buildAdminInstruction({programId,admin:owner,action:'set-config',keeper});assert.equal(pause.data[40],1);
 assert.throws(()=>buildAdminInstruction({programId,admin:owner,action:'set-config',keeper:SystemProgram.programId.toBase58()}));
});
test('operator registration fixes both pools to the shared approved asset registry',()=>{
 const market=MARKETS[0],ix=buildAdminInstruction({programId,admin:owner,action:'register-asset',assetMint:market.mint});
 assert.equal(ix.keys[4].pubkey.toBase58(),market.pools[0]);assert.equal(ix.keys[5].pubkey.toBase58(),market.pools[1]);
 assert.throws(()=>buildAdminInstruction({programId,admin:owner,action:'register-asset',assetMint:owner}));
});
