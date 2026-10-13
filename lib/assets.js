// Mint decimals verified on Solana mainnet. Amounts here are unscaled token units;
// Token-2022 Scaled UI multipliers are separate from a mint's decimal precision.
export const USDC = Object.freeze({
  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
});

export const ASSETS = Object.freeze([
  { symbol: 'AAPLx', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', decimals: 8 },
  { symbol: 'TSLAx', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', decimals: 8 },
  { symbol: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', decimals: 8 },
  { symbol: 'MSFTx', mint: 'XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX', decimals: 8 },
  { symbol: 'GOOGLx', mint: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN', decimals: 8 },
]);

export function assetForMint(mint) {
  return ASSETS.find(asset => asset.mint === mint);
}

export function displayAmount(raw, decimals) {
  // Conversion is for display only. Quote requests retain the original integers.
  return Number(raw) / 10 ** decimals;
}
