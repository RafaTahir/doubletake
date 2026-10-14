/** Prepare an unsigned, reviewable operator action. Never reads keys or submits. */
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Connection,PublicKey,TransactionMessage,VersionedTransaction} from '@solana/web3.js';
import {buildAdminInstruction,deriveProgramAddresses,derivePda,decodeServiceConfig,UPGRADEABLE_LOADER_PROGRAM,DEVELOPMENT_PROGRAM_ID,type AdminInstructionInput} from '../../shared/program.ts';
import {MARKETS} from '../../shared/registry.ts';

const options=new Map<string,string>();
for(let i=2;i<process.argv.length;i+=2){const name=process.argv[i],value=process.argv[i+1];if(!name?.startsWith('--')||!value||value.startsWith('--')||options.has(name))throw new Error('Arguments must be unique --name value pairs');options.set(name,value);}
const required=(name:string)=>{const value=options.get(name);if(!value)throw new Error(`${name} is required`);return value;};
const boolean=(name:string)=>{const value=options.get(name);if(value===undefined)return undefined;if(value!=='true'&&value!=='false')throw new Error(`${name} must be true or false`);return value==='true';};
const rpcEndpoint=required('--rpc'),cluster=required('--cluster'),programId=new PublicKey(required('--program')).toBase58(),admin=new PublicKey(required('--admin')).toBase58();
const supportedActions=['initialize-config','set-config','create-invite','set-invite','register-asset','refresh-asset'] as const;
const action=required('--action');if(!supportedActions.includes(action as typeof supportedActions[number]))throw new Error('Unsupported operator action');
if(!['mainnet-beta','devnet','localnet'].includes(cluster))throw new Error('Unsupported cluster');
if(cluster==='mainnet-beta'&&programId===DEVELOPMENT_PROGRAM_ID)throw new Error('Replace the development program identity and rebuild before preparing any mainnet action');
if(cluster==='localnet'&&!['127.0.0.1','localhost','[::1]'].includes(new URL(rpcEndpoint).hostname))throw new Error('Localnet requires a loopback RPC');
const connection=new Connection(rpcEndpoint,'confirmed'),genesisHash=await connection.getGenesisHash();
const expectedGenesis=cluster==='mainnet-beta'?'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d':cluster==='devnet'?'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG':null;
if(expectedGenesis&&genesisHash!==expectedGenesis)throw new Error('RPC genesis does not match the requested cluster');
const programDataAddress=derivePda(UPGRADEABLE_LOADER_PROGRAM,[new PublicKey(programId).toBytes()]);
const [program,programData]=await connection.getMultipleAccountsInfo([new PublicKey(programId),new PublicKey(programDataAddress)]);
if(!program?.executable||!program.owner.equals(new PublicKey(UPGRADEABLE_LOADER_PROGRAM))||program.data.length!==36||program.data.readUInt32LE(0)!==2||!new PublicKey(program.data.subarray(4)).equals(new PublicKey(programDataAddress)))throw new Error('Upgradeable deployment identity does not match canonical ProgramData');
if(!programData?.owner.equals(new PublicKey(UPGRADEABLE_LOADER_PROGRAM))||programData.data.length<=45||programData.data.readUInt32LE(0)!==3)throw new Error('Deployed ProgramData is unavailable');
const upgradeAuthority=programData.data[12]===1?new PublicKey(programData.data.subarray(13,45)).toBase58():null;
if(action==='initialize-config'&&upgradeAuthority!==admin)throw new Error('Only the actual deployment upgrade authority can initialize config');
const addresses=deriveProgramAddresses(programId,admin),config=await connection.getAccountInfo(new PublicKey(addresses.config));
if(action==='initialize-config'&&config)throw new Error('Config already exists');
if(action!=='initialize-config'&&(!config||decodeServiceConfig(config,programId).admin!==admin))throw new Error('Administrator does not match the on-chain config');
const assetOption=options.get('--asset'),asset=assetOption?MARKETS.find(m=>m.symbol===assetOption||m.mint===assetOption):undefined;
if(assetOption&&!asset)throw new Error('Unsupported asset');
const input:AdminInstructionInput={programId,admin,action:action as AdminInstructionInput['action'],keeper:options.get('--keeper'),owner:options.get('--owner'),assetMint:asset?.mint,paused:boolean('--paused'),enabled:boolean('--enabled')};
const instruction=buildAdminInstruction(input),latest=await connection.getLatestBlockhash('confirmed');
const message=new TransactionMessage({payerKey:new PublicKey(admin),recentBlockhash:latest.blockhash,instructions:[instruction]}).compileToV0Message();
const transaction=new VersionedTransaction(message),networkFee=await connection.getFeeForMessage(message,'confirmed');
const output={kind:'unsigned-operator-preparation',action,cluster,genesisHash,programId,programDataAddress,upgradeAuthority,administrator:admin,programDataBytecodeSha256:createHash('sha256').update(programData.data.subarray(45)).digest('hex'),blockhash:latest.blockhash,lastValidBlockHeight:latest.lastValidBlockHeight,networkFeeLamports:networkFee.value===null?null:String(networkFee.value),servicePaused:action==='initialize-config'?true:action==='set-config'?input.paused!==false:null,requiresReleaseGates:cluster==='mainnet-beta',unsignedTransactionBase64:Buffer.from(transaction.serialize()).toString('base64'),messageHash:createHash('sha256').update(message.serialize()).digest('hex'),instruction:{programId,accounts:instruction.keys.map(key=>({address:key.pubkey.toBase58(),signer:key.isSigner,writable:key.isWritable})),dataHex:instruction.data.toString('hex')},createdAt:new Date().toISOString(),notice:'Unsigned only. Verify release gates, bytecode, authorities, accounts and permissions in a wallet before signing. This script never broadcasts.'};
const outputFile=path.resolve(options.get('--out')??`onchain/fixtures/generated/admin-${action}.json`);await mkdir(path.dirname(outputFile),{recursive:true});await writeFile(outputFile,JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({result:'prepared-unsigned',action,cluster,programId,administrator:admin,outputFile,servicePaused:output.servicePaused,networkFeeLamports:output.networkFeeLamports}));
