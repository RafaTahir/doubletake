import {useMemo} from 'react';
import {ConnectionProvider,WalletProvider,useWallet} from '@solana/wallet-adapter-react';
import {WalletModalProvider,WalletMultiButton} from '@solana/wallet-adapter-react-ui';
import {PhantomWalletAdapter} from '@solana/wallet-adapter-phantom';
import {SolflareWalletAdapter} from '@solana/wallet-adapter-solflare';
import '@solana/wallet-adapter-react-ui/styles.css';
export function WalletShell({children}:{children:React.ReactNode}){const wallets=useMemo(()=>[new PhantomWalletAdapter(),new SolflareWalletAdapter()],[]);return <ConnectionProvider endpoint="https://api.mainnet-beta.solana.com"><WalletProvider wallets={wallets} autoConnect={false}><WalletModalProvider>{children}</WalletModalProvider></WalletProvider></ConnectionProvider>}
export function WalletConnect(){const {publicKey,connected}=useWallet();return <div className="wallet-connect"><span>{connected?'Connected read-only · no signatures':'Connect Phantom or Solflare · no signatures'}</span><WalletMultiButton/>{connected&&<small title={publicKey?.toBase58()}>{publicKey?.toBase58()}</small>}</div>}
export {useWallet};
