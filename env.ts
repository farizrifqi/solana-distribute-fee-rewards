export const RPC_URL = process.env.RPC_URL ?? "";
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY ?? "";
export const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
export const MAINNET = process.env.MAINNET == "true" ? true : false;

if (!RPC_URL) {
  console.error(`RPC_URL not set on .env`);
  process.exit();
}

if (!HELIUS_API_KEY) {
  console.error(`HELIUS_API_KEY not set on .env`);
  process.exit();
}

if (!PRIVATE_KEY) {
  console.error(`PRIVATE_KEY not set on .env`);
  process.exit();
}
