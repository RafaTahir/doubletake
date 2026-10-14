/** Deliberately isolated web3.js v1 interop boundary for the deployed wallet stack. */
import {Buffer} from 'buffer';
import {Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, type AccountInfo, type AccountMeta} from '@solana/web3.js';
import {BETA_LIMITS, MARKETS, RAYDIUM_CLMM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, USDC, marketByMint} from './registry.ts';
import type {OwnerAction, StrategyPolicy, TransactionIntent, Cluster} from './types.ts';

export const DEVELOPMENT_PROGRAM_ID = 'Fg6PaFpoGXkYsidMpWxqSWYQMRqmBhJWv4eCxT9CLn1q';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const discriminators = {
 initialize: [48,191,163,44,71,129,63,164], configure: [129,53,99,52,49,176,249,156],
 deposit: [242,35,198,137,82,225,242,182], withdraw: [183,18,70,156,148,109,161,34],
 pause: [250,6,228,57,6,104,19,210], revoke: [250,6,228,57,6,104,19,210],
 recover: [52,9,13,47,11,112,158,81], execute: [84,207,215,6,85,26,163,240],
 close: [141,103,17,126,72,75,29,29],
} as const;
const accountDiscriminators = {
 vault: [211,8,232,43,2,152,117,119], config: [44,54,70,165,171,124,37,15],
 asset: [57,112,247,166,247,64,140,23], invite: [230,17,253,74,50,78,85,101],
} as const;
const pk = (key: string | PublicKey) => typeof key === 'string' ? new PublicKey(key) : key;
const meta = (key: string | PublicKey, writable = false, signer = false): AccountMeta => ({pubkey: pk(key), isWritable: writable, isSigner: signer});
function integer(raw: string, minimum = 0n, maximum = 0xffffffffffffffffn): bigint {
 if (!/^(0|[1-9][0-9]*)$/.test(raw)) throw new Error('Amount must be an unsigned integer string');
 const n = BigInt(raw); if (n < minimum || n > maximum) throw new Error('Amount is outside permitted bounds'); return n;
}
function u64(raw: string): Uint8Array {const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, integer(raw), true); return bytes;}
function i64(value: number): Uint8Array {if (!Number.isSafeInteger(value)) throw new Error('Timestamp must be a safe integer'); const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true); return bytes;}
function concat(...parts: readonly Uint8Array[]): Buffer {return Buffer.concat(parts.map(part => Buffer.from(part)));}

export function derivePda(programId: string, seeds: readonly Uint8Array[]): string {return PublicKey.findProgramAddressSync(seeds.map(seed => Buffer.from(seed)), pk(programId))[0].toBase58();}
export function deriveAta(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
 return derivePda(ASSOCIATED_TOKEN_PROGRAM, [pk(owner).toBytes(), pk(tokenProgram).toBytes(), pk(mint).toBytes()]);
}
export function deriveProgramAddresses(programId: string, owner: string, assetMint?: string) {
 const config = derivePda(programId, [new TextEncoder().encode('config')]);
 const invite = derivePda(programId, [new TextEncoder().encode('invite'), pk(owner).toBytes()]);
 const vault = derivePda(programId, [new TextEncoder().encode('vault'), pk(owner).toBytes()]);
 const market = assetMint ? marketByMint(assetMint) : undefined;
 if (assetMint && !market) throw new Error('Asset is not supported');
 return {config, invite, vault, vaultUsdc: deriveAta(vault, USDC.mint), ownerUsdc: deriveAta(owner, USDC.mint),
  ...(market ? {assetConfig: derivePda(programId, [new TextEncoder().encode('asset'), pk(market.mint).toBytes()]), vaultAsset: deriveAta(vault, market.mint, market.tokenProgram), ownerAsset: deriveAta(owner, market.mint, market.tokenProgram)} : {})};
}

export const UPGRADEABLE_LOADER_PROGRAM = 'BPFLoaderUpgradeab1e11111111111111111111111';
export interface AdminInstructionInput {
 programId:string;admin:string;action:'initialize-config'|'set-config'|'create-invite'|'set-invite'|'register-asset'|'refresh-asset';
 keeper?:string;owner?:string;assetMint?:string;paused?:boolean;enabled?:boolean;
}
/** Operator preparation only: creates no signer, submits nothing, admits exact registry pools. */
export function buildAdminInstruction(input:AdminInstructionInput):TransactionInstruction {
 const config=derivePda(input.programId,[new TextEncoder().encode('config')]);
 const tags={
  'initialize-config':[208,127,21,1,194,190,196,70], 'set-config':[108,158,154,175,212,98,52,66],
  'create-invite':[160,94,130,54,134,245,255,229], 'set-invite':[148,176,135,186,106,106,89,196],
  'register-asset':[21,80,155,149,117,207,235,16], 'refresh-asset':[31,207,239,157,30,209,66,55],
 } as const;
 let keys:AccountMeta[],args:Uint8Array<ArrayBufferLike>=new Uint8Array();
 if(input.action==='initialize-config'||input.action==='set-config'){
  if(!input.keeper||pk(input.keeper).equals(SystemProgram.programId))throw new Error('A nonzero default keeper is required');
  args=pk(input.keeper).toBytes();
  keys=[meta(input.admin,input.action==='initialize-config',true),meta(config,true)];
  if(input.action==='initialize-config')keys.push(meta(derivePda(UPGRADEABLE_LOADER_PROGRAM,[pk(input.programId).toBytes()])),meta(SystemProgram.programId));
  else args=concat(args,Uint8Array.of(input.paused===false?0:1));
 }else if(input.action==='create-invite'||input.action==='set-invite'){
  if(!input.owner)throw new Error('Invite owner is required');
  const invite=derivePda(input.programId,[new TextEncoder().encode('invite'),pk(input.owner).toBytes()]);
  keys=[meta(input.admin,input.action==='create-invite',true),meta(config,true),meta(invite,true)];
  if(input.action==='create-invite'){keys.push(meta(SystemProgram.programId));args=pk(input.owner).toBytes();}
  else args=Uint8Array.of(input.enabled===true?1:0);
 }else{
  const market=input.assetMint?marketByMint(input.assetMint):undefined;if(!market)throw new Error('A supported registry asset is required');
  const asset=derivePda(input.programId,[new TextEncoder().encode('asset'),pk(market.mint).toBytes()]);
  keys=[meta(input.admin,input.action==='register-asset',true),meta(config),meta(asset,true),meta(market.mint)];
  if(input.action==='register-asset')keys.push(meta(market.pools[0]),meta(market.pools[1]),meta(SystemProgram.programId));
  else args=Uint8Array.of(input.enabled===true?1:0);
 }
 return new TransactionInstruction({programId:pk(input.programId),keys,data:concat(Uint8Array.from(tags[input.action]),args)});
}

export interface OwnerInstructionInput {
 programId: string; owner: string; action: OwnerAction | 'close'; assetMint?: string;
 amountRaw?: string; cycleAmountRaw?: string; minProfitRaw?: string;
 keeper?: string; expiresAt?: number; enabled?: boolean; buyPoolFirst?: boolean;
 nowSeconds?: number;
}
/** Reconstruct from explicit local user choices; never sign server-supplied bytes blindly. */
export function buildOwnerInstruction(input: OwnerInstructionInput): TransactionInstruction {
 const {programId, owner, action} = input;
 const addresses = deriveProgramAddresses(programId, owner, input.assetMint);
 const market = input.assetMint ? marketByMint(input.assetMint) : undefined;
 const ownerMeta = meta(owner, action === 'initialize' || action === 'close', true);
 const vaultMeta = meta(addresses.vault, true);
 let keys: AccountMeta[]; let args: Uint8Array<ArrayBufferLike> = new Uint8Array();
 const requireMarket = () => {if (!market || !addresses.assetConfig || !addresses.vaultAsset || !addresses.ownerAsset) throw new Error('Supported asset is required'); return market;};
 if (action === 'initialize' || action === 'configure') {
  const m = requireMarket();
  integer(input.cycleAmountRaw ?? '', 1n, BigInt(BETA_LIMITS.cycleUsdcRaw));
  integer(input.minProfitRaw ?? '', BigInt(BETA_LIMITS.minProfitUsdcRaw));
  args = concat(u64(input.cycleAmountRaw!), u64(input.minProfitRaw!));
  if (action === 'initialize') {
   keys = [ownerMeta, meta(addresses.config), meta(addresses.invite), vaultMeta, meta(addresses.assetConfig!), meta(USDC.mint), meta(m.mint),
    meta(addresses.vaultUsdc, true), meta(addresses.vaultAsset!, true), meta(SystemProgram.programId), meta(TOKEN_PROGRAM), meta(m.tokenProgram), meta(ASSOCIATED_TOKEN_PROGRAM)];
  } else {
   if (!input.keeper) throw new Error('Verified on-chain keeper is required');
   const expiry = input.expiresAt ?? 0;
   if (input.enabled) {const now = input.nowSeconds ?? Math.floor(Date.now() / 1000); if (expiry <= now || expiry > now + BETA_LIMITS.permissionSeconds) throw new Error('Permission must expire within 24 hours');}
   args = concat(pk(input.keeper).toBytes(), args, i64(input.enabled ? expiry : 0), Uint8Array.of(input.enabled ? 1 : 0, input.buyPoolFirst === false ? 0 : 1));
   keys = [ownerMeta, meta(addresses.config), meta(addresses.invite), vaultMeta, meta(addresses.assetConfig!), meta(m.mint)];
  }
 } else if (action === 'pause' || action === 'revoke') {keys = [ownerMeta, vaultMeta];}
 else if (action === 'deposit' || action === 'withdraw') {
  integer(input.amountRaw ?? '', 1n, action === 'deposit' ? BigInt(BETA_LIMITS.depositUsdcRaw) : 0xffffffffffffffffn);
  args = u64(input.amountRaw!);
  keys = action === 'deposit' ? [ownerMeta, meta(addresses.config), meta(addresses.invite), vaultMeta] : [ownerMeta, vaultMeta];
  keys.push(meta(USDC.mint), meta(addresses.vaultUsdc, true), meta(addresses.ownerUsdc, true), meta(TOKEN_PROGRAM));
 } else if (action === 'recover' || action === 'close') {
  const m = requireMarket();
  keys = [ownerMeta, vaultMeta, meta(m.mint), meta(addresses.vaultAsset!, true), meta(addresses.ownerAsset!, true), meta(m.tokenProgram)];
  if (action === 'recover') {integer(input.amountRaw ?? '', 1n); args = u64(input.amountRaw!);}
  else {keys = [ownerMeta, vaultMeta, meta(addresses.invite,true), meta(USDC.mint), meta(m.mint), meta(addresses.vaultUsdc, true), meta(addresses.vaultAsset!, true), meta(TOKEN_PROGRAM), meta(m.tokenProgram)];}
 } else {throw new Error('Unsupported owner action');}
 return new TransactionInstruction({programId: pk(programId), keys, data: concat(Uint8Array.from(discriminators[action]), args)});
}

export interface PoolExecutionAccounts {pool: string; config: string; usdcVault: string; assetVault: string; observation: string; tickAccounts: string[]}
export interface ExecuteInstructionInput {
 programId: string; owner: string; keeper: string; assetMint: string;
 nonce: string; deadlineSlot: string; buyMinimumOutRaw: string; sellMinimumOutRaw: string;
 buyPoolFirst: boolean; poolA: PoolExecutionAccounts; poolB: PoolExecutionAccounts;
}
export function buildExecuteInstruction(input: ExecuteInstructionInput): TransactionInstruction {
 const m = marketByMint(input.assetMint); if (!m) throw new Error('Unsupported execution asset');
 if (input.poolA.pool !== m.pools[0] || input.poolB.pool !== m.pools[1]) throw new Error('Execution requires the exact approved pool pair');
 const a = deriveProgramAddresses(input.programId, input.owner, m.mint);
 const buy = input.buyPoolFirst ? input.poolA : input.poolB, sell = input.buyPoolFirst ? input.poolB : input.poolA;
 for (const pool of [buy, sell]) {
  if (pool.tickAccounts.length < 1 || pool.tickAccounts.length > 8 || new Set(pool.tickAccounts).size !== pool.tickAccounts.length) throw new Error('Invalid execution tick arrays');
 }
 integer(input.buyMinimumOutRaw, 1n); integer(input.sellMinimumOutRaw, BigInt(BETA_LIMITS.minProfitUsdcRaw) + 1n);
 const keys = [meta(input.keeper, false, true), meta(a.config), meta(a.invite), meta(a.vault, true), meta(a.assetConfig!), meta(USDC.mint), meta(m.mint),
  meta(a.vaultUsdc, true), meta(a.vaultAsset!, true), meta(RAYDIUM_CLMM_PROGRAM), meta(TOKEN_PROGRAM), meta(TOKEN_2022_PROGRAM), meta(MEMO_PROGRAM)];
 for (const pool of [input.poolA, input.poolB]) keys.push(meta(pool.config), meta(pool.pool, true), meta(pool.usdcVault, true), meta(pool.assetVault, true), meta(pool.observation, true));
 keys.push(...buy.tickAccounts.map(key => meta(key, true)), ...sell.tickAccounts.map(key => meta(key, true)));
 return new TransactionInstruction({programId: pk(input.programId), keys, data: concat(Uint8Array.from(discriminators.execute), u64(input.nonce), u64(input.deadlineSlot), u64(input.buyMinimumOutRaw), u64(input.sellMinimumOutRaw), Uint8Array.of(buy.tickAccounts.length))});
}
export const buildExecute = buildExecuteInstruction;

class Reader {
 data: Uint8Array; offset = 8; view: DataView;
 constructor(info: AccountInfo<Uint8Array>, programId: string, discriminator: readonly number[], length: number) {
  if (!info.owner.equals(pk(programId)) || info.data.length !== length || discriminator.some((byte,i) => info.data[i] !== byte)) throw new Error('Invalid program account');
  this.data = info.data; this.view = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
 }
 key(){const key = new PublicKey(this.data.subarray(this.offset, this.offset + 32)).toBase58(); this.offset += 32; return key;}
 unsigned(){const value = this.view.getBigUint64(this.offset, true).toString(); this.offset += 8; return value;}
 signed(){const value = this.view.getBigInt64(this.offset, true); this.offset += 8; if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Timestamp outside supported range'); return Number(value);}
 u8(){return this.data[this.offset++];}
 u16(){const n = this.view.getUint16(this.offset, true); this.offset += 2; return n;}
 bool(){const n = this.u8(); if (n > 1) throw new Error('Invalid account boolean'); return n === 1;}
 bytes(n:number){const value = this.data.subarray(this.offset,this.offset+n);this.offset+=n;return value;}
}
export interface ChainVaultState {
 owner:string;keeper:string;assetMint:string;poolA:string;poolB:string;assetRevision:string;principalUsdcRaw:string;accountedProfitUsdcRaw:string;cycleAmountRaw:string;minProfitRaw:string;
 expiresAt:number;nonce:string;lastExecutedAt:number;executionDay:number;dailyCycles:number;paused:boolean;buyPoolFirst:boolean;bump:number;createdAt:number;
}
export function decodeVaultState(info: AccountInfo<Uint8Array>, programId: string): ChainVaultState {
 const r = new Reader(info,programId,accountDiscriminators.vault,253);
 return {owner:r.key(),keeper:r.key(),assetMint:r.key(),poolA:r.key(),poolB:r.key(),assetRevision:r.unsigned(),principalUsdcRaw:r.unsigned(),accountedProfitUsdcRaw:r.unsigned(),cycleAmountRaw:r.unsigned(),minProfitRaw:r.unsigned(),expiresAt:r.signed(),nonce:r.unsigned(),lastExecutedAt:r.signed(),executionDay:r.signed(),dailyCycles:r.u16(),paused:r.bool(),buyPoolFirst:r.bool(),bump:r.u8(),createdAt:r.signed()};
}
export function decodeServiceConfig(info: AccountInfo<Uint8Array>,programId:string){const r=new Reader(info,programId,accountDiscriminators.config,75);return{admin:r.key(),keeper:r.key(),paused:r.bool(),inviteCount:r.u8(),bump:r.u8()};}
export function decodeAssetConfig(info:AccountInfo<Uint8Array>,programId:string){const r=new Reader(info,programId,accountDiscriminators.asset,179);return{mint:r.key(),poolA:r.key(),poolB:r.key(),tokenProgram:r.key(),fingerprint:Array.from(r.bytes(32),b=>b.toString(16).padStart(2,'0')).join(''),revision:r.unsigned(),decimals:r.u8(),enabled:r.bool(),bump:r.u8()};}
export function decodeInvite(info:AccountInfo<Uint8Array>,programId:string){const r=new Reader(info,programId,accountDiscriminators.invite,50);return{owner:r.key(),enabled:r.bool(),bump:r.u8(),nonceSeed:r.unsigned()};}
/** Strict equality for independently reconstructed owner instructions. */
export function assertInstructionMatches(actual:TransactionInstruction,expected:TransactionInstruction):void {
 if(!actual.programId.equals(expected.programId)||!Buffer.from(actual.data).equals(expected.data)||actual.keys.length!==expected.keys.length||actual.keys.some((key,i)=>!key.pubkey.equals(expected.keys[i].pubkey)||key.isSigner!==expected.keys[i].isSigner||key.isWritable!==expected.keys[i].isWritable)) throw new Error('Transaction differs from the action reviewed by the owner');
}
export function registeredPoolPair(assetMint:string):readonly[string,string]{const m=marketByMint(assetMint);if(!m)throw new Error('Unsupported mint');return m.pools;}
export const PROGRAM_ACCOUNT_SIZES = Object.freeze({vault:253,config:75,asset:179,invite:50});
export const SUPPORTED_PROGRAM_MINTS = MARKETS.map(m=>m.mint);

export interface OwnerTransactionExpectation {
 action: OwnerAction | 'fee-funding'; owner:string; programId:string; amountRaw?:string;
 policy?:StrategyPolicy; keeper?:string; feeWallet?:string; enabled?:boolean;
}
export function ownerAtaCreation(owner:string,mint:string,tokenProgram=TOKEN_PROGRAM):TransactionInstruction {
 const ata=deriveAta(owner,mint,tokenProgram);
 return new TransactionInstruction({programId:pk(ASSOCIATED_TOKEN_PROGRAM),data:Buffer.from([1]),keys:[meta(owner,true,true),meta(ata,true),meta(owner),meta(mint),meta(SystemProgram.programId),meta(tokenProgram)]});
}
/** Every account, amount, program and signer must match a locally rebuilt message. */
export function validateOwnerTransaction(unsignedBytes:Uint8Array,expected:OwnerTransactionExpectation):void {
 const transaction=VersionedTransaction.deserialize(unsignedBytes);
 if(transaction.message.version===0&&transaction.message.addressTableLookups.length)throw new Error('Owner actions must not use opaque address lookups');
 const decoded=TransactionMessage.decompile(transaction.message);
 if(!decoded.payerKey.equals(pk(expected.owner))||transaction.message.header.numRequiredSignatures!==1)throw new Error('The connected owner must be the only signer and fee payer');
 let canonical:TransactionInstruction;
 if(expected.action==='fee-funding') {
  if(!expected.feeWallet)throw new Error('Reviewed fee wallet is required');
  integer(expected.amountRaw??'',1n,BigInt(BETA_LIMITS.feeBalanceLamports));
  canonical=SystemProgram.transfer({fromPubkey:pk(expected.owner),toPubkey:pk(expected.feeWallet),lamports:BigInt(expected.amountRaw!)});
 } else {
  const market=expected.policy?marketByMint(expected.policy.assetMint):undefined;
  if(expected.policy&&(!market||!market.pools.includes(expected.policy.poolBuy)||!market.pools.includes(expected.policy.poolSell)||expected.policy.poolBuy===expected.policy.poolSell))throw new Error('Reviewed strategy has an invalid pool pair');
  canonical=buildOwnerInstruction({programId:expected.programId,owner:expected.owner,action:expected.action,assetMint:expected.policy?.assetMint,amountRaw:expected.amountRaw,cycleAmountRaw:expected.policy?.cycleAmountRaw,minProfitRaw:expected.policy?.minProfitRaw,keeper:expected.keeper,expiresAt:expected.policy?Math.floor(Date.parse(expected.policy.expiresAt)/1000):0,enabled:expected.enabled??true,buyPoolFirst:!market||expected.policy?.poolBuy===market.pools[0]});
 }
 const rebuilt:TransactionInstruction[]=[];
 let units=200_000n,price=0n,seenLimit=false,seenPrice=false,seenAction=false,seenAta=false;
 for(const instruction of decoded.instructions){
  if(instruction.programId.equals(ComputeBudgetProgram.programId)){
   if(seenAction||instruction.keys.length)throw new Error('Unexpected compute instruction');
   const data=instruction.data;
   if(data[0]===2&&data.length===5&&!seenLimit){units=BigInt(data.readUInt32LE(1));if(units<1n||units>1_400_000n)throw new Error('Compute limit is excessive');seenLimit=true;rebuilt.push(ComputeBudgetProgram.setComputeUnitLimit({units:Number(units)}));}
   else if(data[0]===3&&data.length===9&&!seenPrice){price=data.readBigUInt64LE(1);seenPrice=true;rebuilt.push(ComputeBudgetProgram.setComputeUnitPrice({microLamports:price}));}
   else throw new Error('Unreviewed compute instruction');
  } else if(instruction.programId.equals(pk(ASSOCIATED_TOKEN_PROGRAM))){
   if(seenAction||seenAta||!['deposit','withdraw','recover'].includes(expected.action))throw new Error('Unreviewed account creation');
   const market=expected.policy?marketByMint(expected.policy.assetMint):undefined;
   if(expected.action==='recover'&&!market)throw new Error('Recovery mint must be reviewed');
   rebuilt.push(ownerAtaCreation(expected.owner,expected.action==='recover'?market!.mint:USDC.mint,expected.action==='recover'?market!.tokenProgram:TOKEN_PROGRAM));seenAta=true;
  } else {if(seenAction)throw new Error('Additional unreviewed transaction instruction');rebuilt.push(canonical);seenAction=true;}
 }
 if(!seenAction)throw new Error('Expected owner action is missing');
 const fee=5_000n+(units*price+999_999n)/1_000_000n;
 if(fee>BigInt(BETA_LIMITS.attemptFeeLamports))throw new Error('Maximum transaction fee exceeds the beta limit');
 const message=new TransactionMessage({payerKey:pk(expected.owner),recentBlockhash:decoded.recentBlockhash,instructions:rebuilt});
 const rebuiltMessage=transaction.message.version===0?message.compileToV0Message():message.compileToLegacyMessage();
 if(!Buffer.from(transaction.message.serialize()).equals(Buffer.from(rebuiltMessage.serialize())))throw new Error('Transaction differs from the reviewed action, recipient, amount or permissions');
}

export interface IndependentOwnerInput {rpcEndpoint:string;programId:string;owner:string;action:'pause'|'revoke'|'withdraw';amountRaw?:string;cluster?:Cluster}
/** Owner recovery does not need the API, keeper, email provider or database. */
export async function prepareIndependentOwnerAction(input:IndependentOwnerInput):Promise<TransactionIntent> {
 const connection=new Connection(input.rpcEndpoint,'confirmed');
 const cluster=input.cluster??'mainnet-beta';
 const genesis=await connection.getGenesisHash();
 const expectedGenesis=cluster==='mainnet-beta'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':cluster==='devnet'?'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG':null;
 if(expectedGenesis&&genesis!==expectedGenesis)throw new Error('Recovery RPC does not match the selected Solana cluster');
 if(cluster==='localnet'&&!['127.0.0.1','localhost','[::1]'].includes(new URL(input.rpcEndpoint).hostname))throw new Error('Localnet recovery requires a loopback RPC endpoint');
 const a=deriveProgramAddresses(input.programId,input.owner);
 const [program,vaultInfo]=await connection.getMultipleAccountsInfo([pk(input.programId),pk(a.vault)],'confirmed');
 if(!program?.executable||!vaultInfo)throw new Error('Deployed program or owner vault is unavailable');
 const vault=decodeVaultState(vaultInfo,input.programId);
 if(vault.owner!==input.owner)throw new Error('Vault owner does not match the connected wallet');
 const instructions:TransactionInstruction[]=[];
 if(input.action==='withdraw'){
  const info=await connection.getAccountInfo(pk(a.vaultUsdc),'confirmed');
  if(!info||!info.owner.equals(pk(TOKEN_PROGRAM))||info.data.length!==165||new PublicKey(info.data.subarray(0,32)).toBase58()!==USDC.mint||new PublicKey(info.data.subarray(32,64)).toBase58()!==a.vault)throw new Error('Canonical USDC vault account is unavailable');
  const amount=integer(input.amountRaw??'',1n,info.data.readBigUInt64LE(64));
  if(amount===0n)throw new Error('Withdrawal amount must be positive');
  instructions.push(ownerAtaCreation(input.owner,USDC.mint));
 }
 instructions.push(buildOwnerInstruction({programId:input.programId,owner:input.owner,action:input.action,amountRaw:input.amountRaw}));
 const latest=await connection.getLatestBlockhash('confirmed');
 const message=new TransactionMessage({payerKey:pk(input.owner),recentBlockhash:latest.blockhash,instructions}).compileToV0Message();
 const tx=new VersionedTransaction(message);
 const simulated=await connection.simulateTransaction(tx,{sigVerify:false,commitment:'confirmed'});
 if(simulated.value.err)throw new Error(`Owner action simulation failed: ${JSON.stringify(simulated.value.err)}`);
 const fee=await connection.getFeeForMessage(message,'confirmed');
 if(fee.value===null||fee.value>Number(BETA_LIMITS.attemptFeeLamports))throw new Error('Network fee could not be verified within the limit');
 const bytes=tx.serialize();validateOwnerTransaction(bytes,{action:input.action,owner:input.owner,programId:input.programId,amountRaw:input.amountRaw});
 const messageBytes=Uint8Array.from(message.serialize());
 const digest=await crypto.subtle.digest('SHA-256',messageBytes);
 const now=new Date().toISOString();
 return {id:`independent-${crypto.randomUUID()}`,owner:input.owner,strategyId:null,kind:input.action,status:'prepared',unsignedTransactionBase64:Buffer.from(bytes).toString('base64'),messageHash:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),feePayer:input.owner,blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,signature:null,expectedUsdcDeltaRaw:input.action==='withdraw'?input.amountRaw!:null,reservedFeeLamports:'0',summary:{title:input.action==='withdraw'?'Withdraw USDC and pause automation':'Pause and revoke automation',recipient:input.owner,amountRaw:input.amountRaw??null,token:input.action==='withdraw'?'USDC':'Permission',cluster,networkFeeLamports:String(fee.value)},createdAt:now,updatedAt:now,error:null};
}

/** Byte-identical with the on-chain normalized issuer configuration hash. */
export async function calculateMintFingerprint(info:AccountInfo<Uint8Array>,nowSeconds:number):Promise<string> {
 const owner=info.owner.toBase58(),data=info.data;
 if(![TOKEN_PROGRAM,TOKEN_2022_PROGRAM].includes(owner)||data.length<82||data[45]!==1)throw new Error('Invalid mint account');
 const chunks:Uint8Array[]=[new TextEncoder().encode('doubletake-mint-v1'),info.owner.toBytes(),data.subarray(0,36),data.subarray(44,45),data.subarray(46,82)];
 if(owner===TOKEN_PROGRAM){if(data.length!==82)throw new Error('Invalid classic mint size');}
 else if(data.length>82){
  if(data.length<166||data[165]!==1)throw new Error('Invalid Token-2022 mint layout');
  const view=new DataView(data.buffer,data.byteOffset,data.byteLength),entries:{kind:number;data:Uint8Array}[]=[];
  let offset=166;
  while(offset<data.length){
   if(data.subarray(offset).every(b=>b===0))break;
   if(data.length-offset<4)throw new Error('Truncated mint extension');
   const kind=view.getUint16(offset,true),size=view.getUint16(offset+2,true),end=offset+4+size;
   if(kind===0||end>data.length||entries.some(e=>e.kind===kind))throw new Error('Invalid mint extension');
   entries.push({kind,data:data.subarray(offset+4,end)});offset=end;
  }
  entries.sort((a,b)=>a.kind-b.kind);
  for(const extension of entries){
   const {kind}=extension,bytes=extension.data;
   let normalized=bytes;
   if([3,4,12,18,19,20,21,22,23].includes(kind)){/* public issuer controls */}
   else if(kind===6){if(bytes.length!==1||bytes[0]!==1)throw new Error('Issuer default account is frozen');}
   else if(kind===14){if(bytes.length!==64||!bytes.subarray(32).every(b=>b===0))throw new Error('Active transfer hook is unsupported');}
   else if(kind===25){
    if(bytes.length!==56)throw new Error('Invalid scaled UI amount extension');
    const scaled=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),multiplier=scaled.getFloat64(32,true),activation=scaled.getBigInt64(40,true),next=scaled.getFloat64(48,true);
    if(!Number.isFinite(multiplier)||multiplier<=0||!Number.isFinite(next)||next<=0)throw new Error('Invalid issuer multiplier');
    const now=BigInt(Math.trunc(nowSeconds)),difference=now>=activation?now-activation:activation-now;
    if(activation>0n&&difference<=900n)throw new Error('Multiplier activation is within fifteen minutes');
    normalized=bytes.subarray(0,32);
   } else if(kind===26){if(bytes.length!==33||bytes[32]!==0)throw new Error('Issuer mint is paused');}
   else throw new Error(`Unsupported mint extension ${kind}`);
   const header=new Uint8Array(4);const h=new DataView(header.buffer);h.setUint16(0,kind,true);h.setUint16(2,normalized.length,true);
   chunks.push(header,normalized);
  }
 }
 const hash=await crypto.subtle.digest('SHA-256',Uint8Array.from(concat(...chunks)));
 return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
