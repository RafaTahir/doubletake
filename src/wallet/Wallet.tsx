import { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
  useWallet,
} from "@solana/wallet-adapter-react";
import {
  WalletModalProvider,
  WalletMultiButton,
} from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
export function WalletShell({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    [],
  );
  const endpoint = new URL("/api/rpc", window.location.origin).toString();
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
export function WalletConnect({
  showAddress = false,
}: {
  showAddress?: boolean;
}) {
  const { publicKey, connected } = useWallet();
  return (
    <div className="wallet-connect">
      <WalletMultiButton />
      {connected && showAddress && (
        <small title={publicKey?.toBase58()}>{publicKey?.toBase58()}</small>
      )}
    </div>
  );
}
export { useWallet };
