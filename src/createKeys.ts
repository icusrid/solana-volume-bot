// src/createKeys.ts
import { Keypair, PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';

interface CreateKeypairsResult {
  success: boolean;
  message: string;
  wallets: Keypair[];
  pubkeys?: string[];
}

// === PER-USER KEYPAIRS ===
export function getUserKeypairsDir(userId: number): string {
  const userDir = path.join(__dirname, 'user_keypairs', userId.toString());
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

function generateWallets(num: number): Keypair[] {
  const wallets: Keypair[] = [];
  for (let i = 0; i < num; i++) {
    wallets.push(Keypair.generate());
  }
  return wallets;
}

function saveKeypairToFile(keypair: Keypair, index: number, userDir: string) {
  const filePath = path.join(userDir, `keypair${index + 1}.json`);
  fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
}

function readKeypairsFromDisk(userDir: string): Keypair[] {
  const files = fs.readdirSync(userDir)
    .filter(f => /^keypair\d+\.json$/.test(f))
    .sort();

  return files.map(file => {
    const filePath = path.join(userDir, file);
    const secretKey = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Keypair.fromSecretKey(new Uint8Array(secretKey));
  });
}

function updatePoolInfo(wallets: Keypair[], userDir: string) {
  const keyInfoPath = path.join(userDir, 'keyInfo.json');
  const poolInfo: any = { numOfWallets: wallets.length };

  wallets.forEach((w, i) => {
    poolInfo[`pubkey${i + 1}`] = w.publicKey.toString();
  });

  fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));
}

// === EXPORT: PER-USER CREATE ===
export async function createKeypairs(
  userId: number,
  mode: 'create' | 'use',
  numWallets: number = 5
): Promise<CreateKeypairsResult> {
  const userDir = getUserKeypairsDir(userId);

  try {
    let wallets: Keypair[] = [];
    let message = '';

    if (mode === 'create') {
      if (!Number.isInteger(numWallets) || numWallets <= 0 || numWallets > 20) {
        return { success: false, message: 'Use 1–20 wallets.', wallets: [] };
      }

      const existing = readKeypairsFromDisk(userDir);
      if (existing.length > 0) {
        return { success: false, message: 'You already have keypairs! Use "use" mode.', wallets: [] };
      }

      wallets = generateWallets(numWallets);
      wallets.forEach((w, i) => saveKeypairToFile(w, i, userDir));
      message = `Created ${wallets.length} keypairs for you.`;
    }
    else if (mode === 'use') {
      wallets = readKeypairsFromDisk(userDir);
      if (wallets.length === 0) {
        return { success: false, message: 'No keypairs found. Use "create" first.', wallets: [] };
      }
      message = `Loaded ${wallets.length} keypairs.`;
    }
    else {
      return { success: false, message: 'Invalid mode.', wallets: [] };
    }

    updatePoolInfo(wallets, userDir);
    const pubkeys = wallets.map(w => w.publicKey.toString());

    return { success: true, message, wallets, pubkeys };
  } catch (err: any) {
    return { success: false, message: `Error: ${err.message}`, wallets: [] };
  }
}

// === LOAD FOR USER ===
export function loadKeypairs(userId: number): Keypair[] {
  const userDir = getUserKeypairsDir(userId);
  return readKeypairsFromDisk(userDir);
}

// import { Keypair, PublicKey } from '@solana/web3.js';
// import * as fs from 'fs';
// import path from 'path';

// const keypairsDir = path.join(__dirname, 'keypairs');
// const keyInfoPath = path.join(__dirname, 'keyInfo.json');

// interface IPoolInfo {
//   [key: string]: any;
//   numOfWallets?: number;
// }

// // Ensure directory exists
// if (!fs.existsSync(keypairsDir)) {
//   fs.mkdirSync(keypairsDir, { recursive: true });
// }

// // --- Helper Functions ---
// function generateWallets(num: number): Keypair[] {
//   const wallets: Keypair[] = [];
//   for (let i = 0; i < num; i++) {
//     wallets.push(Keypair.generate());
//   }
//   return wallets;
// }

// function saveKeypairToFile(keypair: Keypair, index: number) {
//   const filePath = path.join(keypairsDir, `keypair${index + 1}.json`);
//   fs.writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
// }

// function readKeypairsFromDisk(): Keypair[] {
//   const files = fs.readdirSync(keypairsDir)
//     .filter(f => /^keypair\d+\.json$/.test(f))
//     .sort(); // optional: keep order

//   return files.map(file => {
//     const filePath = path.join(keypairsDir, file);
//     const secretKey = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
//     return Keypair.fromSecretKey(new Uint8Array(secretKey));
//   });
// }

// function updatePoolInfo(wallets: Keypair[]) {
//   let poolInfo: IPoolInfo = {};

//   if (fs.existsSync(keyInfoPath)) {
//     try {
//       poolInfo = JSON.parse(fs.readFileSync(keyInfoPath, 'utf8'));
//     } catch {}
//   }

//   poolInfo.numOfWallets = wallets.length;
//   wallets.forEach((w, i) => {
//     poolInfo[`pubkey${i + 1}`] = w.publicKey.toString();
//   });

//   fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));
// }

// // --- EXPORTED: Telegram-Compatible ---
// export interface CreateKeypairsResult {
//   success: boolean;
//   message: string;
//   wallets: Keypair[];
//   pubkeys?: string[];
// }

// /**
//  * Create or load keypairs — **no prompts**
//  * @param mode 'create' | 'use'
//  * @param numWallets Only used if mode === 'create'
//  */
// export async function createKeypairs(
//   mode: 'create' | 'use',
//   numWallets: number = 5
// ): Promise<CreateKeypairsResult> {
//   try {
//     let wallets: Keypair[] = [];
//     let message = '';

//     if (mode === 'create') {
//       if (!Number.isInteger(numWallets) || numWallets <= 0) {
//         return {
//           success: false,
//           message: 'Invalid number of wallets. Must be positive integer.',
//           wallets: []
//         };
//       }

//       // Warn: only safe if wallets are empty
//       const existing = readKeypairsFromDisk();
//       if (existing.length > 0) {
//         return {
//           success: false,
//           message: 'Existing keypairs found! Delete them first or use "use" mode.',
//           wallets: []
//         };
//       }

//       wallets = generateWallets(numWallets);
//       wallets.forEach((w, i) => saveKeypairToFile(w, i));
//       message = `Created ${wallets.length} new keypairs.`;
//     }
//     else if (mode === 'use') {
//       wallets = readKeypairsFromDisk();
//       if (wallets.length === 0) {
//         return {
//           success: false,
//           message: 'No existing keypairs found in /keypairs folder.',
//           wallets: []
//         };
//       }
//       message = `Loaded ${wallets.length} existing keypairs.`;
//     }
//     else {
//       return {
//         success: false,
//         message: 'Invalid mode. Use "create" or "use".',
//         wallets: []
//       };
//     }

//     // Update pool info
//     updatePoolInfo(wallets);

//     // Return pubkeys for Telegram display
//     const pubkeys = wallets.map(w => w.publicKey.toString());

//     return {
//       success: true,
//       message,
//       wallets,
//       pubkeys
//     };
//   } catch (err: any) {
//     return {
//       success: false,
//       message: `Error: ${err.message}`,
//       wallets: []
//     };
//   }
// }

// // --- Optional: Legacy loader (unchanged) ---
// export function loadKeypairs(): Keypair[] {
//   return readKeypairsFromDisk();
// }

// import  {Keypair}  from '@solana/web3.js';
// import * as fs from 'fs';
// import promptSync from 'prompt-sync';
// import path from 'path';

// const prompt = promptSync();

// const keypairsDir = path.join(__dirname, 'keypairs');
// const keyInfoPath = path.join(__dirname, 'keyInfo.json');

// interface IPoolInfo {
//   [key: string]: any;
//   numOfWallets?: number;
// }

// // Ensure the keypairs directory exists
// if (!fs.existsSync(keypairsDir)) {
//   fs.mkdirSync(keypairsDir, { recursive: true });
// }

// function generateWallets(numOfWallets: number): Keypair[] {
//   let wallets: Keypair[] = [];
//   for (let i = 0; i < numOfWallets; i++) {
//     const wallet = Keypair.generate();
//     wallets.push(wallet);
//   }
//   return wallets;
// }

// function saveKeypairToFile(keypair: Keypair, index: number) {
//   const keypairPath = path.join(keypairsDir, `keypair${index + 1}.json`);
//   fs.writeFileSync(keypairPath, JSON.stringify(Array.from(keypair.secretKey)));
// }

// function readKeypairs(): Keypair[] {
//   const files = fs.readdirSync(keypairsDir);
//   return files.map(file => {
//     const filePath = path.join(keypairsDir, file);
//     const secretKey = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
//     return Keypair.fromSecretKey(new Uint8Array(secretKey));
//   });
// }

// function updatePoolInfo(wallets: Keypair[]) {
//   let poolInfo: IPoolInfo = {}; // Use the defined type here

//   // Check if poolInfo.json exists and read its content
//   if (fs.existsSync(keyInfoPath)) {
//     const data = fs.readFileSync(keyInfoPath, 'utf8');
//     poolInfo = JSON.parse(data);
//   }

//   // Update wallet-related information
//   poolInfo.numOfWallets = wallets.length;
//   wallets.forEach((wallet, index) => {
//     poolInfo[`pubkey${index + 1}`] = wallet.publicKey.toString();
//   });

//   // Write updated data back to poolInfo.json
//   fs.writeFileSync(keyInfoPath, JSON.stringify(poolInfo, null, 2));
// }

// export async function createKeypairs() {
//   console.log('WARNING: If you create new ones, ensure you don\'t have SOL, OR ELSE IT WILL BE GONE.');
//   const action = prompt('Do you want to (c)reate new wallets or (u)se existing ones? (c/u): ');
//   let wallets: Keypair[] = [];

//   if (action === 'c') {
//     const numOfWallets = 5; // Hardcode 5 buyer keypairs here.
//     if (isNaN(numOfWallets) || numOfWallets <= 0) {
//       console.log('Invalid number. Please enter a positive integer.');
//       return;
//     }

//     wallets = generateWallets(numOfWallets);
//     wallets.forEach((wallet, index) => {
//       saveKeypairToFile(wallet, index);
//       console.log(`Wallet ${index + 1} Public Key: ${wallet.publicKey.toString()}`);
//     });
//   } else if (action === 'u') {
//     wallets = readKeypairs();
//     wallets.forEach((wallet, index) => {
//       console.log(`Read Wallet ${index + 1} Public Key: ${wallet.publicKey.toString()}`);
//     });
//   } else {
//     console.log('Invalid option. Please enter "c" for create or "u" for use existing.');
//     return;
//   }

//   updatePoolInfo(wallets);
//   console.log(`${wallets.length} wallets have been processed.`);
// }

// export function loadKeypairs(): Keypair[] {
//   // Define a regular expression to match filenames like 'keypair1.json', 'keypair2.json', etc.
//   const keypairRegex = /^keypair\d+\.json$/;

//   return fs.readdirSync(keypairsDir)
//     .filter(file => keypairRegex.test(file)) // Use the regex to test each filename
//     .map(file => {
//       const filePath = path.join(keypairsDir, file);
//       const secretKeyString = fs.readFileSync(filePath, { encoding: 'utf8' });
//       const secretKey = Uint8Array.from(JSON.parse(secretKeyString));
//       return Keypair.fromSecretKey(secretKey);
//     });
// }
