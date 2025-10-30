import { Telegraf, Context, session, Markup } from "telegraf";
import { createKeypairs } from "./src/createKeys";
import { volume } from "./src/bot";
import { sender, createReturns } from "./src/distribute";
import { calculateVolumeAndSolLoss } from "./src/simulate";
import { connection, wallet } from "./config";
import * as dotenv from "dotenv";
import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { setUserWallet } from "./config";

dotenv.config();

// === MARKDOWN V2 ESCAPE ===
const esc = (text: string): string =>
  text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, "\\$1");

// === USER WALLETS ===
const WALLETS_DIR = path.join(__dirname, "user_wallets");
if (!fs.existsSync(WALLETS_DIR)) fs.mkdirSync(WALLETS_DIR);

// === CONFIG ===
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "YOUR_BOT_TOKEN";
const ADMIN_ID = Number(process.env.ADMIN_ID) || 123456789;

const bot = new Telegraf(TELEGRAM_TOKEN);

// === Extend Context with Session ===
interface BotSession {
    waitingFor?: "dist_sol_ata" | "dist_wsol" | "simulate" | "volume";
    editMsgId?: number;
}

declare module "telegraf" {
    interface Context {
        session?: BotSession;
    }
}

// === Middleware ===
bot.use(session());
// bot.use((ctx, next) => {
//     if (ctx.from?.id !== ADMIN_ID) {
//         ctx.reply("Unauthorized.");
//         return;
//     }
//     return next();
// });
// === MIDDLEWARE: Load User Wallet ===
bot.use(async (ctx: Context & { userWallet?: Keypair }, next) => {
  const userId = ctx.from?.id;
  if (!userId) return next();

  const walletPath = path.join(WALLETS_DIR, `${userId}.json`);
  if (fs.existsSync(walletPath)) {
    const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
    const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    setUserWallet(kp);
    (ctx as any).userWallet = kp;
  }
  return next();
});

// === HELPER: Main Menu ===
// async function sendMainMenu(ctx: Context & { userWallet?: Keypair }) {
//   const userId = ctx.from!.id;
//   const hasWallet = fs.existsSync(path.join(WALLETS_DIR, `${userId}.json`));
//   const balance = hasWallet
//     ? await connection.getBalance((ctx as any).userWallet.publicKey)
//     : 0;
//   const sol = balance / 1e9;

//   const walletAddr = hasWallet
//     ? (ctx as any).userWallet.publicKey.toBase58()
//     : null;

//   const welcome = esc(`
// *Solana Volume Bot* by @icus101

// ${hasWallet ? `*Wallet:* \`${walletAddr?.slice(0, 8)}...${walletAddr?.slice(-6)}\`` : ""}
// ${hasWallet ? `*Balance:* \`${sol.toFixed(6)} SOL\`` : ""}

// ${!hasWallet ? "*Create your wallet to begin!*" : sol < 0.05 ? "*Fund your wallet (≥ 0.05 SOL) to unlock features!*" : ""}
//   `.trim());

//   const keyboard = sol >= 0.05 && hasWallet
//     ? Markup.inlineKeyboard([
//         [Markup.button.callback("1. Create Keypairs", "menu_1")],
//         [Markup.button.callback("2. Distribute", "menu_2")],
//         [Markup.button.callback("3. Simulate", "3")],
//         [Markup.button.callback("4. Start Volume", "4")],
//         [Markup.button.callback("5. Reclaim", "5")],
//         [Markup.button.callback("6. My Wallet", "mywallet")],
//       ])
//     : Markup.keyboard([["/createwallet"], ["/mywallet"]]).resize();

//   await ctx.reply(welcome, {
//     parse_mode: "MarkdownV2",
//     reply_markup: keyboard.reply_markup,
//   });
// }

async function sendMainMenu(ctx: Context & { userWallet?: Keypair }) {
  const userId = ctx.from!.id;
  const hasWallet = fs.existsSync(path.join(WALLETS_DIR, `${userId}.json`));
  const balance = hasWallet
    ? await connection.getBalance((ctx as any).userWallet.publicKey)
    : 0;
  const sol = balance / 1e9;

  const walletAddr = hasWallet
    ? (ctx as any).userWallet.publicKey.toBase58()
    : null;

  const welcome = esc(`
*Solana Volume Bot* by @icus101

${hasWallet ? `*Wallet:* \`${walletAddr?.slice(0, 8)}...${walletAddr?.slice(-6)}\`` : ""}
${hasWallet ? `*Balance:* \`${sol.toFixed(6)} SOL\`` : ""}

${!hasWallet ? "*Create your wallet to begin!*" : sol < 0.05 ? "*Fund ≥ 0.05 SOL to distribute/volume*" : ""}
  `.trim());

  // Build keyboard
  const buttons = [];

  // Always show Simulate
  buttons.push([Markup.button.callback("3. Simulate", "3")]);

  // Show full menu only if funded
  if (hasWallet && sol >= 0.05) {
    buttons.push(
      [Markup.button.callback("1. Create Keypairs", "menu_1")],
      [Markup.button.callback("2. Distribute", "menu_2")],
      [Markup.button.callback("4. Start Volume", "4")],
      [Markup.button.callback("5. Reclaim", "5")]
    );
  }

  // Always show My Wallet
  buttons.push([Markup.button.callback("6. My Wallet", "mywallet")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx.reply(welcome, {
    parse_mode: "MarkdownV2",
    reply_markup: keyboard.reply_markup,
  });
}

// === COMMANDS ===
bot.command("start", sendMainMenu);
bot.command("menu", sendMainMenu);

// === /createwallet ===
bot.command("createwallet", async (ctx) => {
  const userId = ctx.from!.id;
  const walletPath = path.join(WALLETS_DIR, `${userId}.json`);

  if (fs.existsSync(walletPath)) {
    return ctx.reply(esc("You already have a wallet! Use /mywallet"));
  }

  const keypair = Keypair.generate();
  const address = keypair.publicKey.toBase58();
  const secret = JSON.stringify(Array.from(keypair.secretKey));

  fs.writeFileSync(walletPath, secret);

  const msg = esc(`
*Your Main Wallet Created!*

*Address:* \`${address}\`
*Private Key:* \`${secret}\`

*BACKUP THIS KEY NOW — IT WILL NOT BE SHOWN AGAIN!*

*Next Step:* Send SOL to this address.

Use /mywallet to check balance
  `.trim());

  await ctx.reply(msg, { parse_mode: "MarkdownV2" });
});

// === /mywallet ===
bot.command("mywallet", async (ctx) => {
  const userId = ctx.from!.id;
  const walletPath = path.join(WALLETS_DIR, `${userId}.json`);

  if (!fs.existsSync(walletPath)) {
    return ctx.reply(esc("No wallet found. Use /createwallet"));
  }

  const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
  const address = keypair.publicKey.toBase58();
  const balance = await connection.getBalance(keypair.publicKey);
  const sol = balance / 1e9;

  const status = sol < 0.05
    ? "*Fund it to use the bot!*"
    : "*Ready to distribute!*";

  const msg = esc(`
*Your Wallet*

*Address:* \`${address}\`
*Balance:* \`${sol.toFixed(6)} SOL\`

${status}

Use /menu to continue
  `.trim());

  await ctx.reply(msg, {
    parse_mode: "MarkdownV2",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("Back to Menu", "back_to_menu")],
    ]).reply_markup,
  });
});

// === MENU ACTIONS ===
bot.action("menu_1", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(esc("*Create Keypairs*\n\nChoose:"), {
    parse_mode: "MarkdownV2",
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.button.callback("Create 5", "create_5"),
        Markup.button.callback("Create 10", "create_10"),
      ],
      [Markup.button.callback("Use Existing", "use_existing")],
      [Markup.button.callback("Back", "back_to_menu")],
    ]).reply_markup,
  });
});

bot.action(/^(create_\d+|use_existing)$/, async (ctx) => {
  const data = ctx.match![0];
  const mode = data.startsWith("create_") ? "create" : "use";
  const num = mode === "create" ? parseInt(data.split("_")[1]) : 5;

  await ctx.answerCbQuery();
  const status = await ctx.reply(esc(`Processing: ${mode} ${num} wallet(s)...`));

  try {
    const result = await createKeypairs(mode, num);
    let msg = result.message;
    if (result.success && result.pubkeys) {
      msg += "\n\n*Public Keys:*\n";
      msg += result.pubkeys.map((pk, i) => `${i + 1}. \`${pk}\``).join("\n");
    }
    await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, esc(msg), { parse_mode: "MarkdownV2" });
  } catch (err: any) {
    await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, esc(`Error: ${err.message}`));
  }
});

// === MENU 2: Distribute ===
bot.action("menu_2", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(esc("*Distribute SOL / WSOL*\n\nChoose:"), {
    parse_mode: "MarkdownV2",
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback("1. Send SOL + ATA", "dist_sol_ata")],
      [Markup.button.callback("2. Send WSOL", "dist_wsol")],
      [Markup.button.callback("Back", "back_to_menu")],
    ]).reply_markup,
  });
});

bot.action("dist_sol_ata", async (ctx) => {
  await ctx.answerCbQuery();
  const msg = await ctx.reply(esc("Enter: `SOL_AMOUNT JITO_TIP STEPS`\nEx: `0.005 0.01 5`"), { parse_mode: "MarkdownV2" });
  ctx.session = { waitingFor: "dist_sol_ata", editMsgId: msg.message_id };
});

bot.action("dist_wsol", async (ctx) => {
  await ctx.answerCbQuery();
  const msg = await ctx.reply(esc("Enter: `WSOL_PER_WALLET JITO_TIP STEPS`\nEx: `0.1 0.01 5`"), { parse_mode: "MarkdownV2" });
  ctx.session = { waitingFor: "dist_wsol", editMsgId: msg.message_id };
});

// === MENU 3: Simulate ===
bot.action("3", async (ctx) => {
  await ctx.answerCbQuery();
  const txt = esc(`
*Simulate Volume*

Enter one line:
\`SOL_PRICE  JITO_TIP  EXECUTIONS  W1 W2 W3...\`
_Ex:_ \`180 0.01 10 0.1 0.1 0.1 0.1 0.1\`
  `);
  const msg = await ctx.reply(txt, { parse_mode: "MarkdownV2" });
  ctx.session = { waitingFor: "simulate", editMsgId: msg.message_id };
});

// === MENU 4: Volume ===
bot.action("4", async (ctx) => {
  await ctx.answerCbQuery();
  const txt = esc(`
*Start Volume Bot*

Enter one line:
\`MARKET_ID  CYCLES  DELAY_SEC  JITO_TIP\`
_Ex:_ \`9x...abc 10 3 0.01\`
  `);
  const msg = await ctx.reply(txt, { parse_mode: "MarkdownV2" });
  ctx.session = { waitingFor: "volume", editMsgId: msg.message_id };
});

// === MENU 5: Reclaim ===
bot.action("5", async (ctx) => {
  await ctx.answerCbQuery();
  const status = await ctx.reply(esc("Reclaiming SOL/WSOL..."));

  try {
    const result = await createReturns(0.01);
    const final = result.success
      ? esc(`${result.message}\nBundle: \`${result.bundleId}\``)
      : esc(`Failed: ${result.message}`);
    await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, final, { parse_mode: "MarkdownV2" });
  } catch (err: any) {
    await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, esc(`Error: ${err.message}`));
  }
});

// === MENU 6: My Wallet ===
bot.action("mywallet", (ctx) => ctx.reply("/mywallet"));

// === Back to Menu ===
bot.action("back_to_menu", async (ctx) => {
  await ctx.answerCbQuery();
  await sendMainMenu(ctx);
});

// === TEXT INPUT HANDLER ===
bot.on("text", async (ctx) => {
  if (!ctx.session?.waitingFor || !ctx.message?.text) return;

  const text = ctx.message.text.trim();
  const { waitingFor, editMsgId } = ctx.session;
  delete (ctx.session as any).waitingFor;
  delete (ctx.session as any).editMsgId;

  const status = await ctx.reply(esc("Processing…"));

  try {
    if (waitingFor === "dist_sol_ata" || waitingFor === "dist_wsol") {
      const parts = text.split(/\s+/).map(parseFloat);
      if (parts.length < 3 || parts.some(isNaN)) throw new Error("Invalid input");

      const [amt, tip, steps] = parts;
      const result = await sender((ctx as any).userWallet.publicKey, {
        mode: waitingFor === "dist_sol_ata" ? "sol+ata" : "wsol",
        solAmt: waitingFor === "dist_sol_ata" ? amt : undefined,
        wsolAmtPerWallet: waitingFor === "dist_wsol" ? amt : undefined,
        jitoTipAmt: tip * 1e9,
        steps: steps ?? 5,
      });

      const final = result.success
        ? esc(`${result.message}\nBundle: \`${result.bundleId}\``)
        : esc(`Failed: ${result.message}`);
      await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, final, { parse_mode: "MarkdownV2" });
    }

    else if (waitingFor === "simulate") {
      const nums = text.split(/\s+/).map(parseFloat);
      if (nums.length < 4 || nums.some(isNaN)) throw new Error("Need ≥4 numbers");

      const [solPrice, jitoTip, executions, ...walletAmts] = nums;
      const result = await calculateVolumeAndSolLoss(solPrice, jitoTip, executions, walletAmts);
      await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, esc(result.message), { parse_mode: "MarkdownV2" });
    }

    else if (waitingFor === "volume") {
      const parts = text.split(/\s+/);
      if (parts.length !== 4) throw new Error("Need 4 values");

      const [marketID, cyclesStr, delayStr, tipStr] = parts;
      const cycles = parseInt(cyclesStr, 10);
      const delay = parseFloat(delayStr);
      const tip = parseFloat(tipStr);

      if (isNaN(cycles) || isNaN(delay) || isNaN(tip)) throw new Error("Invalid numbers");

      volume(marketID, cycles, delay, tip)
        .then((res) => {
          const final = res.success
            ? esc(`${res.message}\nBundles:\n${res.bundleIds.map((b, i) => `${i + 1}. \`${b}\``).join("\n")}`)
            : esc(`Failed: ${res.message}`);
          ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, final, { parse_mode: "MarkdownV2" });
        })
        .catch((e) => ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, esc(`Error: ${e.message}`)));
    }
  } catch (e: any) {
    await ctx.telegram.editMessageText(ctx.chat!.id, status.message_id, undefined, esc(`Error: ${e.message}`));
  }
});
// === Launch ===
bot.launch({
    webhook: {
        domain: process.env.WEBHOOK_DOMAIN || "https://beda5533bbcb.ngrok-free.app",
        port: parseInt(process.env.WEBHOOK_PORT || "3000"),
    },
}).then(() => console.log("✅ Volume Bot is running..."));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));