import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  MessageV0,
  Blockhash,
  TransactionMessage,
} from "@solana/web3.js";
import { loadKeypairs } from "./createKeys";
import { wallet, connection, tipAcct } from "../config";
import { lookupTableProvider } from "./clients/LookupTableProvider";
import * as spl from "@solana/spl-token";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";

//
// ────────────────────────────────────── HELPERS ──────────────────────────────────────
//

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size));
  return chunks;
}

/** Build + sign a VersionedTransaction (no prompts) */
async function createAndSignVersionedTx(
  instructions: TransactionInstruction[],
  blockhash: string,
  feePayer: PublicKey,
  extraSigners: Keypair[] = []
): Promise<VersionedTransaction> {
  const messageV0 = MessageV0.compile({
    payerKey: feePayer,
    instructions,
    recentBlockhash: blockhash,
  });

  const tx = new VersionedTransaction(messageV0);

  const serialized = tx.serialize();
  console.log("Txn size:", serialized.length);
  if (serialized.length > 1232) console.log("tx too big");

  tx.sign([wallet, ...extraSigners]);
  return tx;
}

/** Send a bundle and return the bundle id (or error) */
async function sendBundle(bundledTxns: VersionedTransaction[]): Promise<string> {
  const bundle = new JitoBundle(bundledTxns, bundledTxns.length);
  const bundleId = await searcherClient.sendBundle(bundle);
  console.log(`Bundle ${bundleId} sent.`);
  return bundleId;
}

/** -------------------------------------------------------------------------- */
/** 1. CREATE WSOL ATA + SEND SOL (fee-only)                                   */
/** -------------------------------------------------------------------------- */
export interface DistributeResult {
  success: boolean;
  message: string;
  txCount?: number;
  bundleId?: string;
}

export async function distributeSolAndCreateATA(
  solAmt: number,          // SOL to send to each wallet (fee-only)
  jitoTipAmt: number,      // tip in lamports
  steps: number = 5,       // how many wallets to touch
  feePayer: PublicKey
): Promise<DistributeResult> {
  try {
    if (solAmt <= 0 || jitoTipAmt <= 0 || steps <= 0)
      return { success: false, message: "All numeric inputs must be > 0" };

    const keypairs = loadKeypairs().slice(0, steps);
    if (keypairs.length === 0)
      return { success: false, message: "No keypairs loaded" };

    const { blockhash } = await connection.getLatestBlockhash();

    // ── 1. Transfer SOL (fee) ─────────────────────────────────────
    const solIxs: TransactionInstruction[] = keypairs.map((kp) =>
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: kp.publicKey,
        lamports: BigInt(solAmt * LAMPORTS_PER_SOL),
      })
    );

    const solChunks = chunkArray(solIxs, 10);
    const solTxns: VersionedTransaction[] = [];

    for (const chunk of solChunks) {
      solTxns.push(await createAndSignVersionedTx(chunk, blockhash, feePayer));
    }

    // ── 2. Create WSOL ATA (idempotent) ─────────────────────────────
    const ataIxs: TransactionInstruction[] = [];
    for (const kp of keypairs) {
      const ata = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, kp.publicKey);
      ataIxs.push(
        spl.createAssociatedTokenAccountIdempotentInstruction(
          feePayer,
          ata,
          kp.publicKey,
          spl.NATIVE_MINT
        )
      );
    }

    const ataChunks = chunkArray(ataIxs, 10);
    const ataTxns: VersionedTransaction[] = [];

    for (let i = 0; i < ataChunks.length; i++) {
      const chunk = ataChunks[i];
      // add tip to the **last** ATA chunk
      if (i === ataChunks.length - 1) {
        chunk.push(
          SystemProgram.transfer({
            fromPubkey: feePayer,
            toPubkey: tipAcct,
            lamports: BigInt(jitoTipAmt),
          })
        );
        console.log("Jito tip added");
      }
      ataTxns.push(await createAndSignVersionedTx(chunk, blockhash, feePayer));
    }

    // ── 3. Bundle & send ───────────────────────────────────────
    const allTxns = [...solTxns, ...ataTxns];
    const bundleId = await sendBundle(allTxns);

    return {
      success: true,
      message: `Sent ${solAmt} SOL + created WSOL ATAs for ${keypairs.length} wallets`,
      txCount: allTxns.length,
      bundleId,
    };
  } catch (err: any) {
    console.error("distributeSolAndCreateATA error:", err);
    return { success: false, message: `Error: ${err.message}` };
  }
}

/** -------------------------------------------------------------------------- */
/** 2. SEND WSOL (actual volume)                                               */
/** -------------------------------------------------------------------------- */
export async function distributeWSOL(
  amountPerWallet: number, // WSOL amount **per wallet** in SOL
  jitoTipAmt: number,      // tip in lamports
  steps: number = 5,
  feePayer: PublicKey
): Promise<DistributeResult> {
  try {
    if (amountPerWallet <= 0 || jitoTipAmt <= 0 || steps <= 0)
      return { success: false, message: "All numeric inputs must be > 0" };

    const keypairs = loadKeypairs().slice(0, steps);
    if (keypairs.length === 0)
      return { success: false, message: "No keypairs loaded" };

    const { blockhash } = await connection.getLatestBlockhash();

    // Build WSOL-wrap instructions (sync + transfer)
    const wsolIxs: TransactionInstruction[] = [];
    for (const kp of keypairs) {
      const ata = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, kp.publicKey);

      // 1. sync native balance (idempotent)
      wsolIxs.push(spl.createSyncNativeInstruction(ata));

      // 2. transfer WSOL from payer → ATA
      wsolIxs.push(
        spl.createTransferInstruction(
          await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, feePayer),
          ata,
          feePayer,
          BigInt(amountPerWallet * LAMPORTS_PER_SOL)
        )
      );
    }

    // Add tip to the **last** chunk
    const chunks = chunkArray(wsolIxs, 6);
    const txns: VersionedTransaction[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (i === chunks.length - 1) {
        chunk.push(
          SystemProgram.transfer({
            fromPubkey: feePayer,
            toPubkey: tipAcct,
            lamports: BigInt(jitoTipAmt),
          })
        );
        console.log("Jito tip added");
      }
      txns.push(await createAndSignVersionedTx(chunk, blockhash, feePayer));
    }

    const bundleId = await sendBundle(txns);

    return {
      success: true,
      message: `Sent ${amountPerWallet} WSOL to ${keypairs.length} wallets`,
      txCount: txns.length,
      bundleId,
    };
  } catch (err: any) {
    console.error("distributeWSOL error:", err);
    return { success: false, message: `Error: ${err.message}` };
  }
}

/** -------------------------------------------------------------------------- */
/** 3. RECLAIM (close WSOL + send remaining SOL back)                         */
/** -------------------------------------------------------------------------- */

export interface ReclaimResult {
  success: boolean;
  bundleId?: string;
  message: string;
  reclaimedCount?: number;
}

export async function createReturns(jitoTipSOL: number = 0.01): Promise<ReclaimResult> {
  const keypairs = loadKeypairs();
  if (keypairs.length === 0) {
    return { success: false, message: "No keypairs found in ./keypairs" };
  }

  const jitoTipLamports = Math.round(jitoTipSOL * LAMPORTS_PER_SOL);
  const { blockhash } = await connection.getLatestBlockhash();

  const txns: VersionedTransaction[] = [];
  const chunkSize = 2;

  for (let i = 0; i < keypairs.length; i += chunkSize) {
    const chunk = keypairs.slice(i, i + chunkSize);
    const ixs: TransactionInstruction[] = [];

    for (const kp of chunk) {
      const wsolATA = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, kp.publicKey);

      // Close WSOL ATA → send lamports to main wallet
      ixs.push(
        spl.createCloseAccountInstruction(wsolATA, wallet.publicKey, kp.publicKey)
      );

      // Send all native SOL back
      const bal = await connection.getBalance(kp.publicKey);
      if (bal > 5000) { // leave dust for rent
        ixs.push(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: wallet.publicKey,
            lamports: BigInt(bal - 5000),
          })
        );
      }
    }

    // Add tip on **last chunk only**
    if (i + chunkSize >= keypairs.length) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: tipAcct,
          lamports: BigInt(jitoTipLamports),
        })
      );
    }

    const msg = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    const signers = [wallet, ...chunk];
    tx.sign(signers);

    const ser = tx.serialize();
    if (ser.length > 1232) {
      return { success: false, message: `Tx too big: ${ser.length} bytes` };
    }

    txns.push(tx);
  }

  try {
    const bundle = new JitoBundle(txns, txns.length);
    const bundleId = await searcherClient.sendBundle(bundle);
    console.log(`Reclaim bundle sent: ${bundleId}`);

    return {
      success: true,
      bundleId,
      reclaimedCount: keypairs.length,
      message: `Reclaimed ${keypairs.length} wallet(s)`,
    };
  } catch (err: any) {
    return { success: false, message: `Bundle failed: ${err.message}` };
  }
}

// export async function createReturns(
//   jitoTipAmt: number = 0.01 * LAMPORTS_PER_SOL
// ): Promise<DistributeResult> {
//   try {
//     const keypairs = loadKeypairs();
//     if (keypairs.length === 0)
//       return { success: false, message: "No keypairs to reclaim" };

//     const { blockhash } = await connection.getLatestBlockhash();

//     const ixs: TransactionInstruction[] = [];
//     const chunkSize = 2;
//     const chunks = chunkArray(keypairs, chunkSize);
//     const txns: VersionedTransaction[] = [];

//     for (let c = 0; c < chunks.length; c++) {
//       const chunk = chunks[c];
//       const chunkIxs: TransactionInstruction[] = [];

//       for (const kp of chunk) {
//         const ata = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, kp.publicKey);

//         // close WSOL ATA → send lamports to wallet
//         chunkIxs.push(
//           spl.createCloseAccountInstruction(ata, wallet.publicKey, kp.publicKey)
//         );

//         // send **all** native SOL back to main wallet
//         const bal = await connection.getBalance(kp.publicKey);
//         if (bal > 0) {
//           chunkIxs.push(
//             SystemProgram.transfer({
//               fromPubkey: kp.publicKey,
//               toPubkey: wallet.publicKey,
//               lamports: BigInt(bal),
//             })
//           );
//         }
//       }

//       // tip on the very last chunk
//       if (c === chunks.length - 1 && jitoTipAmt > 0) {
//         chunkIxs.push(
//           SystemProgram.transfer({
//             fromPubkey: wallet.publicKey,
//             toPubkey: tipAcct,
//             lamports: BigInt(jitoTipAmt),
//           })
//         );
//         console.log("Jito tip added");
//       }

//       const tx = await createAndSignVersionedTx(
//         chunkIxs,
//         blockhash,
//         wallet.publicKey,
//         chunk // extra signers (the keypairs that own the accounts)
//       );
//       txns.push(tx);
//     }

//     const bundleId = await sendBundle(txns);

//     return {
//       success: true,
//       message: `Reclaimed ${keypairs.length} wallets`,
//       txCount: txns.length,
//       bundleId,
//     };
//   } catch (err: any) {
//     console.error("createReturns error:", err);
//     return { success: false, message: `Error: ${err.message}` };
//   }
// }

/** -------------------------------------------------------------------------- */
/** 4. PUBLIC ENTRYPOINT (called from telegram-bot)                           */
/** -------------------------------------------------------------------------- */
export async function sender(
  feePayer: PublicKey,
  options: {
    mode: "sol+ata" | "wsol" | "reclaim";
    solAmt?: number;          // only for sol+ata
    wsolAmtPerWallet?: number;// only for wsol
    jitoTipAmt?: number;      // lamports, defaults 0.01 SOL
    steps?: number;           // default 5
  }
): Promise<DistributeResult> {
  const tip = options.jitoTipAmt ?? 0.01 * LAMPORTS_PER_SOL;
  const steps = options.steps ?? 5;

  switch (options.mode) {
    case "sol+ata":
      if (!options.solAmt) return { success: false, message: "solAmt required" };
      return distributeSolAndCreateATA(options.solAmt, tip, steps, feePayer);

    case "wsol":
      if (!options.wsolAmtPerWallet) return { success: false, message: "wsolAmtPerWallet required" };
      return distributeWSOL(options.wsolAmtPerWallet, tip, steps, feePayer);

    case "reclaim":
      return createReturns(tip);

    default:
      return { success: false, message: "Invalid mode" };
  }
}

// import {
// 	Keypair,
// 	PublicKey,
// 	SystemProgram,
// 	Transaction,
// 	TransactionInstruction,
// 	VersionedTransaction,
// 	Signer,
// 	LAMPORTS_PER_SOL,
// 	TransactionMessage,
// 	Blockhash,
// 	MessageV0,
// 	AddressLookupTableAccount,
// } from "@solana/web3.js";
// import { loadKeypairs } from "./createKeys";
// import { wallet, connection, tipAcct } from "../config";
// import { lookupTableProvider } from "./clients/LookupTableProvider";
// import * as spl from "@solana/spl-token";
// import { searcherClient } from "./clients/jito";
// import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
// import promptSync from "prompt-sync";

// const prompt = promptSync();

// export async function createReturns() {
// 	const txsSigned: VersionedTransaction[] = [];
// 	const keypairs = loadKeypairs();
// 	const chunkedKeypairs = chunkArray(keypairs, 2); // EDIT CHUNKS?

// 	const jitoTipIn = prompt("Jito tip in Sol (Ex. 0.01): ");
// 	const TipAmt = parseFloat(jitoTipIn) * LAMPORTS_PER_SOL;

// 	const { blockhash } = await connection.getLatestBlockhash();

// 	// Iterate over each chunk of keypairs
// 	for (let chunkIndex = 0; chunkIndex < chunkedKeypairs.length; chunkIndex++) {
// 		const chunk = chunkedKeypairs[chunkIndex];
// 		const instructionsForChunk: TransactionInstruction[] = [];

// 		// Iterate over each keypair in the chunk to create swap instructions
// 		for (let i = 0; i < chunk.length; i++) {
// 			const keypair = chunk[i];
// 			console.log(`Processing keypair ${i + 1}/${chunk.length}:`, keypair.publicKey.toString());

// 			const ataAddressKeypair = await spl.getAssociatedTokenAddress(new PublicKey(spl.NATIVE_MINT), keypair.publicKey);

// 			const closeAcctixs = spl.createCloseAccountInstruction(
// 				ataAddressKeypair, // WSOL account to close
// 				wallet.publicKey, // Destination for remaining SOL
// 				keypair.publicKey // Owner of the WSOL account, may need to be the wallet if it's the owner
// 			);

// 			const balance = await connection.getBalance(keypair.publicKey);

// 			const sendSOLixs = SystemProgram.transfer({
// 				fromPubkey: keypair.publicKey,
// 				toPubkey: wallet.publicKey,
// 				lamports: balance,
// 			});

// 			instructionsForChunk.push(closeAcctixs, sendSOLixs);
// 		}

// 		if (chunkIndex === chunkedKeypairs.length - 1) {
// 			const tipSwapIxn = SystemProgram.transfer({
// 				fromPubkey: wallet.publicKey,
// 				toPubkey: tipAcct,
// 				lamports: BigInt(TipAmt),
// 			});
// 			instructionsForChunk.push(tipSwapIxn);
// 			console.log("Jito tip added :).");
// 		}

// 		const addressesMain: PublicKey[] = [];
// 		instructionsForChunk.forEach((ixn) => {
// 			ixn.keys.forEach((key) => {
// 				addressesMain.push(key.pubkey);
// 			});
// 		});

// 		const lookupTablesMain = lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);

// 		const message = new TransactionMessage({
// 			payerKey: wallet.publicKey,
// 			recentBlockhash: blockhash,
// 			instructions: instructionsForChunk,
// 		}).compileToV0Message(lookupTablesMain);

// 		const versionedTx = new VersionedTransaction(message);

// 		const serializedMsg = versionedTx.serialize();
// 		console.log("Txn size:", serializedMsg.length);
// 		if (serializedMsg.length > 1232) {
// 			console.log("tx too big");
// 		}

// 		console.log(
// 			"Signing transaction with chunk signers",
// 			chunk.map((kp) => kp.publicKey.toString())
// 		);

// 		versionedTx.sign([wallet]);

// 		for (const keypair of chunk) {
// 			versionedTx.sign([keypair]);
// 		}

// 		txsSigned.push(versionedTx);
// 	}

// 	await sendBundleWithParameters(txsSigned);
// }

// async function generateSOLTransferForKeypairs(SendAmt: number, steps: number = 5): Promise<TransactionInstruction[]> {
// 	const amount = SendAmt * LAMPORTS_PER_SOL;
// 	const keypairs: Keypair[] = loadKeypairs(); // Load your keypairs
// 	const keypairSOLIxs: TransactionInstruction[] = [];

// 	keypairs.forEach((keypair, index) => {
// 		if (index >= steps) return; // Ensure we only process up to 'steps' keypairs
// 		const transferIx = SystemProgram.transfer({
// 			fromPubkey: wallet.publicKey,
// 			toPubkey: keypair.publicKey,
// 			lamports: amount,
// 		});
// 		keypairSOLIxs.push(transferIx);
// 		console.log(`Transfer of ${Number(amount) / LAMPORTS_PER_SOL} SOL to Wallet ${index + 1} (${keypair.publicKey.toString()}) bundled.`);
// 	});

// 	return keypairSOLIxs;
// }

// // async function createAndSignVersionedTx(instructionsChunk: TransactionInstruction[], blockhash: Blockhash | string, keypairs?: Keypair[]): Promise<VersionedTransaction> {
// // 	const addressesMain: PublicKey[] = [];
// // 	instructionsChunk.forEach((ixn) => {
// // 		ixn.keys.forEach((key) => {
// // 			addressesMain.push(key.pubkey);
// // 		});
// // 	});

// // 	const versionedTx = new VersionedTransaction(instructionsChunk);
// // 	const serializedMsg = versionedTx.serialize();

// // 	console.log("Txn size:", serializedMsg.length);
// // 	if (serializedMsg.length > 1232) {
// // 		console.log("tx too big");
// // 	}

// // 	if (keypairs) {
// // 		versionedTx.sign([wallet, ...keypairs]);
// // 	} else {
// // 		versionedTx.sign([wallet]);
// // 	}

// // 	/*
// //     // Simulate each txn
// //     const simulationResult = await connection.simulateTransaction(versionedTx, { commitment: "processed" });

// //     if (simulationResult.value.err) {
// //     console.log("Simulation error:", simulationResult.value.err);
// //     } else {
// //     console.log("Simulation success. Logs:");
// //     simulationResult.value.logs?.forEach(log => console.log(log));
// //     }
// //     */

// // 	return versionedTx;
// // }

// async function createAndSignVersionedTx(
//     instructionsChunk: TransactionInstruction[],
//     blockhash: string, // recent blockhash as string
//     feePayer: PublicKey, // the wallet paying fees
//     keypairs?: Keypair[] // additional signers
// ): Promise<VersionedTransaction> {
//     // Compile the version #0 message
//     const messageV0 = MessageV0.compile({
//         payerKey: feePayer,
//         instructions: instructionsChunk,
//         recentBlockhash: blockhash,
//     });

//     // Create VersionedTransaction from the compiled message
//     const versionedTx = new VersionedTransaction(messageV0);

//     // Serialize to check size
//     const serializedMsg = versionedTx.serialize();
//     console.log("Txn size:", serializedMsg.length);
//     if (serializedMsg.length > 1232) {
//         console.log("tx too big");
//     }

//     // Sign with wallet (fee payer) + any additional keypairs
//     const signers = keypairs ? [wallet, ...keypairs] : [wallet];
//     versionedTx.sign(signers);

//     /*
//     // Optional: Simulate
//     const simulationResult = await connection.simulateTransaction(versionedTx, { 
//         commitment: "processed",
//         replaceRecentBlockhash: true,
//         sigVerify: false 
//     });

//     if (simulationResult.value.err) {
//         console.log("Simulation error:", simulationResult.value.err);
//     } else {
//         console.log("Simulation success. Logs:");
//         simulationResult.value.logs?.forEach(log => console.log(log));
//     }
//     */

//     return versionedTx;
// }

// async function processInstructionsSOL(blockhash: string | Blockhash,feePayer: PublicKey, keypairSOLIxs: TransactionInstruction[]): Promise<VersionedTransaction[]> {
// 	const instructionChunks = chunkArray(keypairSOLIxs, 10); // Adjust the chunk size as needed
// 	const sendTxns: VersionedTransaction[] = [];

// 	for (let i = 0; i < instructionChunks.length; i++) {
// 		const versionedTx = await createAndSignVersionedTx(instructionChunks[i], blockhash,feePayer);
// 		sendTxns.push(versionedTx);
// 	}

// 	return sendTxns;
// }

// async function distributeWSOL(jitoTip: number, steps = 5,feePayer: PublicKey) {
// 	const keypairs = loadKeypairs();
// 	let totalSolRequired = 0;
// 	const ixsTransfer: TransactionInstruction[] = [];

// 	for (let i = 0; i < Math.min(steps, keypairs.length); i++) {
// 		const amountInSOL = parseFloat(prompt(`Enter the amount of WSOL to send to Wallet ${i + 1}: `));
// 		const distributeAmt = amountInSOL * LAMPORTS_PER_SOL; // Convert SOL to lamports
// 		totalSolRequired += amountInSOL;

// 		const keypair = keypairs[i];
// 		const ataAddressKeypair = await spl.getAssociatedTokenAddress(new PublicKey(spl.NATIVE_MINT), keypair.publicKey);

// 		console.log(`Distributed ${distributeAmt / LAMPORTS_PER_SOL} WSOL to Wallet ${i + 1} (${keypair.publicKey.toString()}) ATA`);
// 	}

// 	ixsTransfer.push(
// 		SystemProgram.transfer({
// 			fromPubkey: wallet.publicKey,
// 			toPubkey: tipAcct,
// 			lamports: BigInt(jitoTip),
// 		})
// 	);
// 	console.log("tip pushed :)");

// 	const bundleTxns: VersionedTransaction[] = [];
// 	const chunkSize = 6; // EDIT CHUNK SIZE
// 	const ixsChunks = chunkArray(ixsTransfer, chunkSize);

// 	const { blockhash } = await connection.getLatestBlockhash();

// 	// Create and sign each chunk of instructions
// 	for (const chunk of ixsChunks) {
// 		const versionedTx = await createAndSignVersionedTx(chunk, blockhash,feePayer);
// 		bundleTxns.push(versionedTx);
// 	}

// 	// Finally... SEND BUNDLE
// 	await sendBundleWithParameters(bundleTxns);
// 	bundleTxns.length = 0;
// 	ixsTransfer.length = 0;
// }

// async function generateWSOLATAForKeypairs(steps: number = 5): Promise<TransactionInstruction[]> {
// 	const keypairs: Keypair[] = loadKeypairs();
// 	const keypairWSOLATAIxs: TransactionInstruction[] = [];

// 	for (const [index, keypair] of keypairs.entries()) {
// 		if (index >= steps) break;
// 		const wsolataAddress = await spl.getAssociatedTokenAddress(new PublicKey(spl.NATIVE_MINT), keypair.publicKey);
// 		const createWSOLAta = spl.createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, wsolataAddress, keypair.publicKey, new PublicKey(spl.NATIVE_MINT));

// 		keypairWSOLATAIxs.push(createWSOLAta);
// 		console.log(`Created WSOL ATA for Wallet ${index + 1} (${keypair.publicKey.toString()}).`);
// 	}

// 	return keypairWSOLATAIxs;
// }

// function chunkArray<T>(array: T[], chunkSize: number): T[][] {
// 	const chunks = [];
// 	for (let i = 0; i < array.length; i += chunkSize) {
// 		chunks.push(array.slice(i, i + chunkSize));
// 	}
// 	return chunks;
// }

// async function processWSOLInstructionsATA(jitoTipAmt: number, blockhash: string | Blockhash,feePayer: PublicKey, keypairWSOLATAIxs: TransactionInstruction[]): Promise<VersionedTransaction[]> {
// 	const instructionChunks = chunkArray(keypairWSOLATAIxs, 10); // Adjust the chunk size as needed
// 	const WSOLtxns: VersionedTransaction[] = [];

// 	for (let i = 0; i < instructionChunks.length; i++) {
// 		if (i === instructionChunks.length - 1) {
// 			const tipIxn = SystemProgram.transfer({
// 				fromPubkey: wallet.publicKey,
// 				toPubkey: tipAcct,
// 				lamports: BigInt(jitoTipAmt),
// 			});
// 			instructionChunks[i].push(tipIxn);
// 			console.log("Jito tip added :).");
// 		}
// 		const versionedTx = await createAndSignVersionedTx(instructionChunks[i], blockhash,feePayer);
// 		WSOLtxns.push(versionedTx);
// 	}

// 	return WSOLtxns;
// }

// async function sendBundleWithParameters(bundledTxns: VersionedTransaction[]) {
// 	/*
//         // Simulate each transaction
//         for (const tx of bundledTxns) {
//             try {
//                 const simulationResult = await connection.simulateTransaction(tx, { commitment: "processed" });
//                 console.log(simulationResult);

//                 if (simulationResult.value.err) {
//                     console.error("Simulation error for transaction:", simulationResult.value.err);
//                 } else {
//                     console.log("Simulation success for transaction. Logs:");
//                     simulationResult.value.logs?.forEach(log => console.log(log));
//                 }
//             } catch (error) {
//                 console.error("Error during simulation:", error);
//             }
//         }
//     */

// 	try {
// 		const bundleId = await searcherClient.sendBundle(new JitoBundle(bundledTxns, bundledTxns.length));
// 		console.log(`Bundle ${bundleId} sent.`);
// 	} catch (error) {
// 		const err = error as any;
// 		console.error("Error sending bundle:", err.message);

// 		if (err?.message?.includes("Bundle Dropped, no connected leader up soon")) {
// 			console.error("Error sending bundle: Bundle Dropped, no connected leader up soon.");
// 		} else {
// 			console.error("An unexpected error occurred:", err.message);
// 		}
// 	}
// }

// async function generateATAandSOL(feePayer: PublicKey) {
// 	const BundledTxns: VersionedTransaction[] = [];

// 	console.log("\n!!! WARNING: SOL IS FOR TXN FEES ONLY !!!");
// 	const SolAmt = prompt("Sol to send (Ex. 0.005): ");
// 	const jitoTipAmtInput = prompt("Jito tip in Sol (Ex. 0.01): ");
// 	const SendAmt = parseFloat(SolAmt);
// 	const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;

// 	const { blockhash } = await connection.getLatestBlockhash();

// 	const sendSolIxs = await generateSOLTransferForKeypairs(SendAmt);
// 	const sendSolTxns = await processInstructionsSOL(blockhash, feePayer,sendSolIxs);
// 	BundledTxns.push(...sendSolTxns);

// 	const wsolATAixs = await generateWSOLATAForKeypairs();
// 	const wsolATATxns = await processWSOLInstructionsATA(jitoTipAmt, blockhash,feePayer, wsolATAixs);
// 	BundledTxns.push(...wsolATATxns);

// 	await sendBundleWithParameters(BundledTxns);
// }

// export async function sender(feePayer: PublicKey) {
// 	let running = true;

// 	while (running) {
// 		console.log("\nBuyer UI:");
// 		console.log("1. Generate WSOL ATA and Send SOL");
// 		console.log("2. Send WSOL (Volume)");

// 		const answer = prompt("Choose an option or 'exit': "); // Use prompt-sync for user input

// 		switch (answer) {
// 			case "1": // NEED
// 				await generateATAandSOL(feePayer);
// 				break;
// 			case "2": // WSOL SEND
// 				const jitoTipIn = prompt("Jito tip in Sol (Ex. 0.01): ");
// 				const TipAmt = parseFloat(jitoTipIn) * LAMPORTS_PER_SOL;
// 				await distributeWSOL(TipAmt,5,feePayer);
// 				break;
// 			case "exit":
// 				running = false;
// 				break;
// 			default:
// 				console.log("Invalid option, please choose again.");
// 		}
// 	}

// 	console.log("Exiting...");
// }
