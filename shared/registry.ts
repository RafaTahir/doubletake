import type { MarketCategory } from "./types.ts";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const RAYDIUM_CLMM_PROGRAM =
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
export const USDC = Object.freeze({
  symbol: "USDC",
  mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
});
export const BETA_LIMITS = Object.freeze({
  depositUsdcRaw: "100000000",
  cycleUsdcRaw: "25000000",
  minProfitUsdcRaw: "50000",
  feeBalanceLamports: "5000000",
  dailyFeeLamports: "500000",
  attemptFeeLamports: "50000",
  maxCyclesPerDay: 10,
  cooldownSeconds: 60,
  permissionSeconds: 86400,
  maxUsers: 5,
  minPoolLiquidityUsd: 10000,
});
export interface MarketDefinition {
  symbol: string;
  name: string;
  mint: string;
  decimals: number;
  category: MarketCategory;
  tokenProgram: string;
  pools: readonly [string, string];
}
export const MARKETS: readonly MarketDefinition[] = Object.freeze([
  {
    symbol: "AAPLx",
    name: "Apple xStock",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    decimals: 8,
    category: "xstock",
    tokenProgram: TOKEN_2022_PROGRAM,
    pools: [
      "CKwJZwm7oj3nu4653N1EpDrqXbXAYXoPFiPeEnLouF8y",
      "ApniVWuZbZoruTAJdyJcLBA4AVw4DKGdV5fHxo6qrAZT",
    ],
  },
  {
    symbol: "TSLAx",
    name: "Tesla xStock",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    decimals: 8,
    category: "xstock",
    tokenProgram: TOKEN_2022_PROGRAM,
    pools: [
      "8aDaBQkTrS6HVMjyc6EZebgdiaXhLYGriDWKWWp1NpFF",
      "HHQUnUbmWLrYzkscDY1C3deEFbGtiGBGoHjpANogmvum",
    ],
  },
  {
    symbol: "NVDAx",
    name: "NVIDIA xStock",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    decimals: 8,
    category: "xstock",
    tokenProgram: TOKEN_2022_PROGRAM,
    pools: [
      "49iMatQtoyabsYAQc8GafVq6aeBFVDxSRH44oiatyyw6",
      "4KqQN6u1pFKroFE2jVEhoepAMRKPcuAzWVDCgm9zRBYN",
    ],
  },
  {
    symbol: "MSFTx",
    name: "Microsoft xStock",
    mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    decimals: 8,
    category: "xstock",
    tokenProgram: TOKEN_2022_PROGRAM,
    pools: [
      "CLu4kFM4nb67xrdN7vJnMxXXir8Z5hA4HJUzPFccXjsL",
      "D6bRhQUcR9B7bPbbqgxpE17MjyUjBtr8hHQCcJoHrrv1",
    ],
  },
  {
    symbol: "GOOGLx",
    name: "Alphabet xStock",
    mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    decimals: 8,
    category: "xstock",
    tokenProgram: TOKEN_2022_PROGRAM,
    pools: [
      "B8YAwjGYk6qidWzGBXMAxP7nYfG8g74EZ3Y4gFSsobRw",
      "9sw1NZjXFsy5GKkqMpQWV7wopGgMcdkanDqg3f15zQZv",
    ],
  },
  {
    symbol: "SOL",
    name: "Solana",
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
    category: "crypto",
    tokenProgram: TOKEN_PROGRAM,
    pools: [
      "3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv",
      "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj",
    ],
  },
  {
    symbol: "JUP",
    name: "Jupiter",
    mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
    decimals: 6,
    category: "crypto",
    tokenProgram: TOKEN_PROGRAM,
    pools: [
      "Fu5uXjR17rGbUur294Ke3UxCH8JF5nWYYCe9wqNjDuFr",
      "5Z2YAbbCeagp8kMTAD61fvbT5bcw45Qjubz8t8YobtZR",
    ],
  },
]);
export function marketByMint(mint: string) {
  return MARKETS.find((asset) => asset.mint === mint);
}
