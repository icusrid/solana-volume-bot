import { LAMPORTS_PER_SOL } from "@solana/web3.js";

const SWAP_TAX_RATE = 0.005; // 0.5 % per swap

export interface SimulateResult {
  success: boolean;
  message: string;          // full Markdown‑ready report
  data?: {
    totalSolSent: number;
    totalSolAfter: number;
    totalSolSpent: number;
    totalVolumeSOL: number;
    totalUsdSpent: number;
    totalUsdVolume: number;
    walletFinal: { index: number; sol: number; usd: number }[];
  };
}

/**
 * Simulate volume & SOL loss – **no prompts**
 *
 * @param solPrice      Current SOL price in USD
 * @param jitoTip       Jito tip **per execution** in SOL
 * @param executions    How many times the swap loop runs
 * @param walletAmounts Array of SOL amounts sent to each wallet (order matters)
 */
export async function calculateVolumeAndSolLoss(
  solPrice: number,
  jitoTip: number,
  executions: number,
  walletAmounts: number[] = [] // default empty → will return error
): Promise<SimulateResult> {
  try {
    // -----------------------------------------------------------------
    // Validation
    // -----------------------------------------------------------------
    if (solPrice <= 0 || jitoTip < 0 || executions <= 0)
      return { success: false, message: "All numeric inputs must be > 0" };

    const numberOfWallets = walletAmounts.length;
    if (numberOfWallets === 0)
      return { success: false, message: "Provide at least one wallet amount" };

    // -----------------------------------------------------------------
    // Core calculation (exactly the same logic you had)
    // -----------------------------------------------------------------
    let totalSolSpentOnTaxes = 0;
    let totalSolSentToWallets = 0;
    let totalVolumeInSOL = 0;
    const walletBalances = [...walletAmounts]; // mutable copy

    walletAmounts.forEach((amt) => (totalSolSentToWallets += amt));

    for (let exec = 0; exec < executions; exec++) {
      for (let i = 0; i < numberOfWallets; i++) {
        const volBefore = walletBalances[i];
        totalVolumeInSOL += volBefore;

        const tax = volBefore * SWAP_TAX_RATE;
        walletBalances[i] -= tax;
        totalSolSpentOnTaxes += tax;
      }
      totalSolSpentOnTaxes += jitoTip; // tip per execution
    }

    const totalSolSpent = totalSolSpentOnTaxes;
    const totalSolAfter = totalSolSentToWallets - totalSolSpent;

    const totalVolumeInUSD = totalVolumeInSOL * solPrice;
    const totalUsdSpent = totalSolSpent * solPrice;

    // -----------------------------------------------------------------
    // Build Markdown report
    // -----------------------------------------------------------------
    const lines: string[] = [];

    lines.push("*Simulation Result*");
    lines.push("");

    // Wallet final balances
    walletBalances.forEach((bal, i) => {
      const usd = bal * solPrice;
      lines.push(
        `*Wallet ${i + 1}* \` ${bal.toFixed(6)} SOL \` ($${usd.toFixed(2)})`
      );
    });

    lines.push("");
    lines.push(`*Total SOL sent to wallets:* \`${totalSolSentToWallets.toFixed(6)}\` SOL`);
    lines.push(`*Total SOL after taxes/tips:* \`${totalSolAfter.toFixed(6)}\` SOL`);
    lines.push(`*Total SOL spent (taxes + tips):* \`${totalSolSpent.toFixed(6)}\` SOL`);
    lines.push(`*Total volume (pre‑tax):* \`${totalVolumeInSOL.toFixed(6)}\` SOL`);
    lines.push(`*USD spent:* \`$${totalUsdSpent.toFixed(2)}\``);
    lines.push(`*USD volume:* \`$${totalVolumeInUSD.toFixed(2)}\``);

    const report = lines.join("\n");

    return {
      success: true,
      message: report,
      data: {
        totalSolSent: totalSolSentToWallets,
        totalSolAfter,
        totalSolSpent,
        totalVolumeSOL: totalVolumeInSOL,
        totalUsdSpent,
        totalUsdVolume: totalVolumeInUSD,
        walletFinal: walletBalances.map((bal, i) => ({
          index: i + 1,
          sol: bal,
          usd: bal * solPrice,
        })),
      },
    };
  } catch (err: any) {
    return { success: false, message: `Error: ${err.message}` };
  }
}

// import { LAMPORTS_PER_SOL } from '@solana/web3.js';
// import promptSync from 'prompt-sync';

// const prompt = promptSync();

// const swapTaxRate = 0.005; // 0.5% tax per swap

// export async function calculateVolumeAndSolLoss() {
//     const numberOfWallets = 5; // 5 wallets per execution

//     // Prompt user for inputs
//     const solPrice = parseFloat(prompt("Enter the current Solana (SOL) price in USD: ") || '0');
//     const jitoTip = parseFloat(prompt("Enter the Jito tip amount per swap call in SOL: ") || '0');
//     const executions = parseInt(prompt("Enter the number of times to execute the swap function: ") || '0', 10);

//     let totalSolSpentOnTaxes = 0;
//     let totalSolSentToWallets = 0;
//     let totalVolumeInSOL = 0;
//     let walletBalances = new Array(numberOfWallets).fill(0);

//     // Get custom send amount for each wallet and store it
//     for (let i = 0; i < numberOfWallets; i++) {
//         const sendAmount = parseFloat(prompt(`Enter the amount of SOL to send to Wallet ${i + 1}: `) || '0');
//         walletBalances[i] = sendAmount; // Store initial send amount in SOL
//         totalSolSentToWallets += sendAmount; // Accumulate total SOL sent to wallets
//     }

//     // Apply tax and calculate final balance and volume for each execution and each wallet
//     for (let j = 0; j < executions; j++) {
//         for (let i = 0; i < numberOfWallets; i++) {
//             const volumeBeforeTax = walletBalances[i]; // Use the current balance for the swap volume
//             totalVolumeInSOL += volumeBeforeTax; // Add volume before tax to total volume

//             const taxAmount = volumeBeforeTax * swapTaxRate; // Calculate tax amount for the current balance
//             walletBalances[i] -= taxAmount; // Deduct tax amount from current balance
//             totalSolSpentOnTaxes += taxAmount; // Add to total SOL spent on taxes
//         }
//         totalSolSpentOnTaxes += jitoTip; // Add the jito tip to the total SOL spent on taxes per execution
//     }

//     // The total SOL spent is the sum of SOL sent to wallets, taxes, and jito tips
//     const totalSolSpent = totalSolSpentOnTaxes;

//     // Convert total volume and SOL spent to USD
//     const totalVolumeInUSD = totalVolumeInSOL * solPrice;
//     const totalUsdGenerated = totalSolSpent * solPrice;

//     // Display the final SOL balance for each wallet after all executions, taxes, and tips
//     console.log('\n');
//     walletBalances.forEach((balance, i) => {
//         console.log(`Wallet ${i + 1} Final Balance: ${balance.toFixed(4)} SOL (${(balance * solPrice).toFixed(2)} USD)`);
//     });

//     console.log(`\nTotal SOL Sent to Wallets: ${totalSolSentToWallets.toFixed(4)} SOL`);
//     console.log(`Total SOL of Wallets After: ${(totalSolSentToWallets - totalSolSpent).toFixed(4)} SOL`);
//     console.log(`Total SOL Spent on Taxes and Tips: ${totalSolSpentOnTaxes.toFixed(4)} SOL`);
//     console.log(`Total Volume in SOL: ${totalVolumeInSOL.toFixed(4)} SOL`);
//     console.log(`Total USD Value Spent: $${totalUsdGenerated.toFixed(2)}`);
//     console.log(`Total USD Volume Generated: $${totalVolumeInUSD.toFixed(2)}`);
// }