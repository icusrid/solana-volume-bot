// src/bot.ts
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  SystemProgram,
  LAMPORTS_PER_SOL,
  Blockhash,
} from "@solana/web3.js";
import { lookupTableProvider } from "./clients/LookupTableProvider";
import { connection, wallet, tipAcct } from "../config";
import { IPoolKeys } from "./clients/interfaces";
import { derivePoolKeys } from "./clients/poolKeysReassigned";
import * as spl from "@solana/spl-token";
import { TOKEN_PROGRAM_ID, MAINNET_PROGRAM_ID } from "@raydium-io/raydium-sdk";
import { searcherClient } from "./clients/jito";
import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";
import { loadKeypairs } from "./createKeys";

/* --------------------------------------------------------------------- */
/*  Helper – build a single swap (buy or sell)                           */
/* --------------------------------------------------------------------- */
function makeSwap(
  poolKeys: IPoolKeys,
  wSolATA: PublicKey,
  tokenATA: PublicKey,
  sell: boolean,
  signer: Keypair
): { buyIxs: TransactionInstruction[]; sellIxs: TransactionInstruction[] } {
  const programId = new PublicKey(
    "Axz6g5nHgKzm5CbLJc43auxpdpkL1BafBywSvotyTUSv"
  ); // <-- YOUR PROGRAM

  const accounts = [
    TOKEN_PROGRAM_ID,
    poolKeys.id,
    poolKeys.authority,
    poolKeys.openOrders,
    poolKeys.targetOrders,
    poolKeys.baseVault,
    poolKeys.quoteVault,
    poolKeys.marketProgramId,
    poolKeys.marketId,
    poolKeys.marketBids,
    poolKeys.marketAsks,
    poolKeys.marketEventQueue,
    poolKeys.marketBaseVault,
    poolKeys.marketQuoteVault,
    poolKeys.marketAuthority,
    sell ? tokenATA : wSolATA, // source
    sell ? wSolATA : tokenATA, // dest
    signer.publicKey,
    MAINNET_PROGRAM_ID.AmmV4,
  ];

  const data = Buffer.concat([Buffer.from([0x09]), Buffer.alloc(16)]);

  const ix = new TransactionInstruction({
    keys: accounts.map((pk, i) => ({
      pubkey: pk,
      isSigner: i === 17, // only the user owner is signer
      isWritable: ![0, 2, 7, 14].includes(i), // read‑only list
    })),
    programId,
    data,
  });

  return sell
    ? { buyIxs: [], sellIxs: [ix] }
    : { buyIxs: [ix], sellIxs: [] };
}

/* --------------------------------------------------------------------- */
/*  One cycle – creates all per‑wallet swap txs and bundles them        */
/* --------------------------------------------------------------------- */
async function executeSwapCycle(
  keypairs: Keypair[],
  marketID: string,
  jitoTipLamports: number,
  blockhash: string
): Promise<string> {
  const poolKeys = await derivePoolKeys(new PublicKey(marketID));
  if (!poolKeys) throw new Error("Failed to fetch pool keys");

  const bundleTxns: VersionedTransaction[] = [];

  for (let i = 0; i < keypairs.length; i++) {
    const kp = keypairs[i];

    const tokenATA = await spl.getAssociatedTokenAddress(poolKeys.baseMint, kp.publicKey);
    const wSolATA = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, kp.publicKey);

    // Idempotent ATA for the base token
    const createATA = spl.createAssociatedTokenAccountIdempotentInstruction(
      kp.publicKey,
      tokenATA,
      kp.publicKey,
      poolKeys.baseMint
    );

    const { buyIxs } = makeSwap(poolKeys, wSolATA, tokenATA, false, kp);
    const { sellIxs } = makeSwap(poolKeys, wSolATA, tokenATA, true, kp);

    const ixs: TransactionInstruction[] = [createATA, ...buyIxs, ...sellIxs];

    // Add tip on the **last** wallet of the cycle
    if (i === keypairs.length - 1) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: tipAcct,
          lamports: BigInt(jitoTipLamports),
        })
      );
    }

    // ---- Build VersionedTransaction ----
    const addresses: PublicKey[] = [];
    ixs.forEach((ix) =>
      ix.keys.forEach((k) => addresses.push(k.pubkey))
    );
    const lut = lookupTableProvider.computeIdealLookupTablesForAddresses(addresses);

    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(lut);

    const tx = new VersionedTransaction(msg);

    // Sign: payer + (if last) wallet for tip
    const signers: Keypair[] = [kp];
    if (i === keypairs.length - 1) signers.push(wallet);
    tx.sign(signers);

    const ser = tx.serialize();
    if (ser.length > 1232) throw new Error(`Tx ${i + 1} too big (${ser.length} bytes)`);

    bundleTxns.push(tx);
  }

  // ---- Send Jito bundle ----
  const bundle = new JitoBundle(bundleTxns, bundleTxns.length);
  const bundleId = await searcherClient.sendBundle(bundle);
  console.log(`Bundle ${bundleId} sent (cycle)`);
  return bundleId;
}

/* --------------------------------------------------------------------- */
/*  Public entry point – called from telegram‑bot.ts                     */
/* --------------------------------------------------------------------- */
export interface VolumeResult {
  success: boolean;
  bundleIds: string[];
  message: string;
}

export async function volume(
  marketID: string,
  cycles: number,
  delaySec: number,
  jitoTipSOL: number
): Promise<VolumeResult> {
  if (!marketID || cycles <= 0 || delaySec < 0 || jitoTipSOL <= 0) {
    return {
      success: false,
      bundleIds: [],
      message: "Invalid parameters",
    };
  }

  const keypairs = loadKeypairs();
  if (keypairs.length === 0) {
    return {
      success: false,
      bundleIds: [],
      message: "No keypairs found in ./keypairs",
    };
  }

  const jitoTipLamports = Math.round(jitoTipSOL * LAMPORTS_PER_SOL);
  const bundleIds: string[] = [];

  try {
    for (let c = 0; c < cycles; c++) {
      console.log(`\n--- Cycle ${c + 1}/${cycles} ---`);
      const { blockhash } = await connection.getLatestBlockhash();
      const bid = await executeSwapCycle(keypairs, marketID, jitoTipLamports, blockhash);
      bundleIds.push(bid);

      if (c < cycles - 1) {
        console.log(`Waiting ${delaySec}s before next cycle…`);
        await new Promise((r) => setTimeout(r, delaySec * 1000));
      }
    }

    return {
      success: true,
      bundleIds,
      message: `Completed ${cycles} cycle(s). ${bundleIds.length} bundle(s) sent.`,
    };
  } catch (err: any) {
    console.error("Volume error:", err);
    return {
      success: false,
      bundleIds,
      message: `Error: ${err.message}`,
    };
  }
}

// import {
// 	//SimulatedTransactionAccountInfo,
// 	TransactionMessage,
// 	VersionedTransaction,
// 	PublicKey,
// 	TransactionInstruction,
// 	Keypair,
// 	SystemProgram,
// 	ComputeBudgetProgram,
// 	LAMPORTS_PER_SOL,
// 	Blockhash,
// } from "@solana/web3.js";
// import { lookupTableProvider } from "./clients/LookupTableProvider";
// import { connection, wallet, tipAcct } from "../config";
// import { IPoolKeys } from "./clients/interfaces";
// import { derivePoolKeys } from "./clients/poolKeysReassigned";
// import * as spl from "@solana/spl-token";
// import { TOKEN_PROGRAM_ID, MAINNET_PROGRAM_ID } from "@raydium-io/raydium-sdk";
// import path from "path";
// import fs from "fs";
// import promptSync from "prompt-sync";
// import { searcherClient } from "./clients/jito";
// import { Bundle as JitoBundle } from "jito-ts/dist/sdk/block-engine/types.js";

// const prompt = promptSync();

// const keypairsDir = path.join(__dirname, "keypairs");

// async function executeSwaps(keypairs: Keypair[], marketID: string, jitoTip: number, block: string | Blockhash) {
// 	const BundledTxns: VersionedTransaction[] = [];

// 	const keys = await derivePoolKeys(new PublicKey(marketID));
// 	if (keys === null) {
// 		console.log("Error fetching poolkeys");
// 		process.exit(0);
// 	}

// 	for (let index = 0; index < keypairs.length; index++) {
// 		const keypair = keypairs[index];

// 		const TokenATA = await spl.getAssociatedTokenAddress(new PublicKey(keys.baseMint), keypair.publicKey);

// 		const wSolATA = await spl.getAssociatedTokenAddress(spl.NATIVE_MINT, keypair.publicKey);

// 		const createTokenBaseAta = spl.createAssociatedTokenAccountIdempotentInstruction(keypair.publicKey, TokenATA, keypair.publicKey, keys.baseMint);

// 		const { buyIxs } = makeSwap(keys, wSolATA, TokenATA, false, keypair);
// 		const { sellIxs } = makeSwap(keys, wSolATA, TokenATA, true, keypair);

// 		let volumeIxs: TransactionInstruction[] = [createTokenBaseAta, ...buyIxs, ...sellIxs];

// 		if (index === keypairs.length - 1) {
// 			const tipIxn = SystemProgram.transfer({
// 				fromPubkey: wallet.publicKey,
// 				toPubkey: tipAcct,
// 				lamports: BigInt(jitoTip),
// 			});
// 			volumeIxs.push(tipIxn);
// 		}

// 		const addressesMain: PublicKey[] = [];
// 		volumeIxs.forEach((ixn) => {
// 			ixn.keys.forEach((key) => {
// 				addressesMain.push(key.pubkey);
// 			});
// 		});

// 		const lookupTablesMain = lookupTableProvider.computeIdealLookupTablesForAddresses(addressesMain);

// 		const messageV0 = new TransactionMessage({
// 			payerKey: keypair.publicKey,
// 			recentBlockhash: block,
// 			instructions: volumeIxs,
// 		}).compileToV0Message(lookupTablesMain);

// 		const volumeTX = new VersionedTransaction(messageV0);

// 		if (index === keypairs.length - 1) {
// 			volumeTX.sign([wallet, keypair]);
// 		} else {
// 			volumeTX.sign([keypair]);
// 		}

// 		try {
// 			const serializedMsg = volumeTX.serialize();
// 			//console.log('Txn size:', serializedMsg.length);
// 			if (serializedMsg.length > 1232) {
// 				console.log("tx too big");
// 				process.exit(0);
// 			}

// 			/*
//           // Simulate the transaction
//           const simulationResult = await connection.simulateTransaction(volumeTX, { commitment: "processed" });
        
//           if (simulationResult.value.err) {
//             console.log("Simulation error:", simulationResult.value.err);
//           } else {
//             console.log("Simulation success. Logs:");
//             simulationResult.value.logs?.forEach(log => console.log(log));
//           }
//           */

// 			BundledTxns.push(volumeTX);
// 		} catch (e) {
// 			console.log(e, "error with volumeTX");
// 			process.exit(0);
// 		}
// 	}

// 	// SEND SUNDLE
// 	await sendBundle(BundledTxns);
// }

// function loadKeypairs(): Keypair[] {
// 	return fs
// 		.readdirSync(keypairsDir)
// 		.filter((file) => file.endsWith(".json"))
// 		.map((file) => {
// 			const filePath = path.join(keypairsDir, file);
// 			const secretKeyString = fs.readFileSync(filePath, { encoding: "utf8" });
// 			const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
// 			return Keypair.fromSecretKey(secretKey);
// 		});
// }

// async function sendBundle(bundledTxns: VersionedTransaction[]) {
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

// export async function volume() {
// 	let keypairs = loadKeypairs();
// 	const marketID = prompt("Enter your market ID: ");
// 	const cyclesIn = prompt("Number of bundled swaps to perform (Ex. 10): ");
// 	const delayIn = prompt("Delay between swaps in seconds (Ex. 3): ");
// 	const jitoTipAmtInput = prompt("Jito tip in Sol (Ex. 0.01): ");
// 	const jitoTipAmt = parseFloat(jitoTipAmtInput) * LAMPORTS_PER_SOL;

// 	const cycles = parseFloat(cyclesIn);
// 	const delay = parseFloat(delayIn);

// 	for (let i = 0; i < cycles; i++) {
// 		console.log(`Cycle ${i + 1}`);
// 		const { blockhash } = await connection.getLatestBlockhash();
// 		await executeSwaps(keypairs, marketID, jitoTipAmt, blockhash);

// 		// Wait for the specified delay before proceeding to the next cycle
// 		await new Promise((resolve) => setTimeout(resolve, delay * 1000));
// 	}

// 	console.log("Execution completed.");
// }

// function makeSwap(poolKeys: IPoolKeys, wSolATA: PublicKey, TokenATA: PublicKey, reverse: boolean, keypair: Keypair) {
// 	const programId = new PublicKey("Axz6g5nHgKzm5CbLJc43auxpdpkL1BafBywSvotyTUSv"); // MY PROGRAM
// 	const account1 = TOKEN_PROGRAM_ID; // token program
// 	const account2 = poolKeys.id; // amm id  writable
// 	const account3 = poolKeys.authority; // amm authority
// 	const account4 = poolKeys.openOrders; // amm open orders  writable
// 	const account5 = poolKeys.targetOrders; // amm target orders  writable
// 	const account6 = poolKeys.baseVault; // pool coin token account  writable  AKA baseVault
// 	const account7 = poolKeys.quoteVault; // pool pc token account  writable   AKA quoteVault
// 	const account8 = poolKeys.marketProgramId; // serum program id
// 	const account9 = poolKeys.marketId; //   serum market  writable
// 	const account10 = poolKeys.marketBids; // serum bids  writable
// 	const account11 = poolKeys.marketAsks; // serum asks  writable
// 	const account12 = poolKeys.marketEventQueue; // serum event queue  writable
// 	const account13 = poolKeys.marketBaseVault; // serum coin vault  writable     AKA marketBaseVault
// 	const account14 = poolKeys.marketQuoteVault; //   serum pc vault  writable    AKA marketQuoteVault
// 	const account15 = poolKeys.marketAuthority; // serum vault signer       AKA marketAuthority
// 	let account16 = wSolATA; // user source token account  writable
// 	let account17 = TokenATA; // user dest token account   writable
// 	const account18 = keypair.publicKey; // user owner (signer)  writable
// 	const account19 = MAINNET_PROGRAM_ID.AmmV4; // ammV4  writable

// 	if (reverse == true) {
// 		account16 = TokenATA;
// 		account17 = wSolATA;
// 	}

// 	const buffer = Buffer.alloc(16);
// 	const prefix = Buffer.from([0x09]);
// 	const instructionData = Buffer.concat([prefix, buffer]);
// 	const accountMetas = [
// 		{ pubkey: account1, isSigner: false, isWritable: false },
// 		{ pubkey: account2, isSigner: false, isWritable: true },
// 		{ pubkey: account3, isSigner: false, isWritable: false },
// 		{ pubkey: account4, isSigner: false, isWritable: true },
// 		{ pubkey: account5, isSigner: false, isWritable: true },
// 		{ pubkey: account6, isSigner: false, isWritable: true },
// 		{ pubkey: account7, isSigner: false, isWritable: true },
// 		{ pubkey: account8, isSigner: false, isWritable: false },
// 		{ pubkey: account9, isSigner: false, isWritable: true },
// 		{ pubkey: account10, isSigner: false, isWritable: true },
// 		{ pubkey: account11, isSigner: false, isWritable: true },
// 		{ pubkey: account12, isSigner: false, isWritable: true },
// 		{ pubkey: account13, isSigner: false, isWritable: true },
// 		{ pubkey: account14, isSigner: false, isWritable: true },
// 		{ pubkey: account15, isSigner: false, isWritable: false },
// 		{ pubkey: account16, isSigner: false, isWritable: true },
// 		{ pubkey: account17, isSigner: false, isWritable: true },
// 		{ pubkey: account18, isSigner: true, isWritable: true },
// 		{ pubkey: account19, isSigner: false, isWritable: true },
// 	];

// 	const swap = new TransactionInstruction({
// 		keys: accountMetas,
// 		programId,
// 		data: instructionData,
// 	});

// 	let buyIxs: TransactionInstruction[] = [];
// 	let sellIxs: TransactionInstruction[] = [];

// 	if (reverse === false) {
// 		buyIxs.push(swap);
// 	}

// 	if (reverse === true) {
// 		sellIxs.push(swap);
// 	}

// 	return { buyIxs, sellIxs };
// }
