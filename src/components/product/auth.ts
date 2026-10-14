export function validateSignInChallenge(
  message: string,
  owner: string,
  origin: string,
  cluster: string,
  expiresAt: string,
): void {
  const nonce = message.match(/^Nonce: ([A-Za-z0-9_-]{20,100})$/m)?.[1];
  const issuedAt = message.match(/^Issued At: (\S+)$/m)?.[1];
  if (
    !nonce ||
    !issuedAt ||
    !Number.isFinite(Date.parse(issuedAt)) ||
    !Number.isFinite(Date.parse(expiresAt))
  )
    throw new Error("The sign-in challenge is incomplete.");
  const expected = `${new URL(origin).host} wants you to sign in with your Solana account:\n${owner}\n\nSign in to DoubleTake. This signature does not authorize a transaction.\n\nURI: ${origin}\nVersion: 1\nChain ID: solana:${cluster}\nNonce: ${nonce}\nIssued At: ${issuedAt}\nExpiration Time: ${expiresAt}`;
  if (message !== expected)
    throw new Error(
      "The sign-in message does not match this wallet, domain and network.",
    );
  if (Date.parse(expiresAt) <= Date.now())
    throw new Error("The sign-in challenge expired. Try again.");
}
