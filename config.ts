import { PublicKey, Connection, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export const rayFee = new PublicKey('7YttLkHDoNj9wyDur5pM1ejNaAvT9X4eqaYcHQqtj2G5');
export const tipAcct = new PublicKey('Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY');
export const RayLiqPoolv4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

export const connection = new Connection("https://devnet.helius-rpc.com/?api-key=a4c93129-769a-49d8-bc1b-918f1f537075", { // RPC URL HERE
  commitment: 'confirmed',
});

// export const wallet = Keypair.fromSecretKey(
//   bs58.decode(
//     '4kW5q5r8ymev1gSge7chW7qv1K5mjtv4GJuKSjXic1r1ZADTRwARCPzbC68EjcETRJ4MG8pnpuUFp4FPB185rZsP' // PRIV KEY OF SOL SENDER
//   )
// );

export let wallet: Keypair;
export let walletPubkey: PublicKey;

export function setUserWallet(kp: Keypair) {
  wallet = kp;
  walletPubkey = kp.publicKey;
}

