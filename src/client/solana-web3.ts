import { PublicKey, VersionedTransaction } from '@solana/web3.js';

export { PublicKey, VersionedTransaction };

const SOLANA_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const SPL_ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function deriveSolanaUsdcAtaBytes32Hex(ownerBase58: string): string {
  const owner = new PublicKey(ownerBase58.trim());
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), SPL_TOKEN_PROGRAM_ID.toBytes(), SOLANA_USDC_MINT.toBytes()],
    SPL_ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const bytes = ata.toBytes();
  let hex = '0x';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
