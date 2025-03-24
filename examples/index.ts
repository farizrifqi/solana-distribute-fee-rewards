import {
  getMint,
  getTokenMetadata,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import Logger from "../src/services/logger";
import RewardDistributionRunner from "../src/distribute";
import { HELIUS_API_KEY, PRIVATE_KEY, RPC_URL } from "../env";

const tokenAddress = "XXXXX";

const rpcURL = RPC_URL;
// const walletFeeAuthority = Keypair.fromSecretKey(new Uint8Array([])); # If Uint8Array Private Key
const walletFeeAuthority = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const logger = new Logger("main");
const connection = new Connection(rpcURL, "confirmed");

const getToken = async (
  connection: Connection,
  mint: PublicKey,
  programId: PublicKey
) => {
  try {
    const tokenInfo = await getMint(connection, mint, "confirmed", programId);
    const tokenMetadata = await getTokenMetadata(
      connection,
      tokenInfo.address,
      "confirmed",
      programId
    );
    if (tokenMetadata) {
      logger.log({
        level: "verbose",
        label: "main",
        message: `Detected token ${tokenMetadata.name} (${tokenMetadata.symbol})`,
      });
    }

    return { ...tokenInfo, programId };
  } catch (err) {
    logger.log({
      level: "error",
      label: "main",
      message: "Mint not found",
    });
    process.exit();
  }
};

const run = async () => {
  const tokenInfo = await getToken(
    connection,
    new PublicKey(tokenAddress),
    TOKEN_2022_PROGRAM_ID
  );
  const distributionRunner = new RewardDistributionRunner({
    connection,
    heliusAPIKey: HELIUS_API_KEY,
    mint: tokenInfo,
    signer: walletFeeAuthority,
    rewards: [
      {
        publicKey: NATIVE_MINT,
        percent: 40,
        programId: TOKEN_PROGRAM_ID,
        name: "SOL",
      },
      {
        name: "USDC",
        publicKey: new PublicKey(
          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        ),
        programId: TOKEN_PROGRAM_ID,
        percent: 60,
      },
    ],
    logger: undefined,
    options: {
      distributionIntervalMinutes: 45,
      swapFeePercent: 75, //! 100% Gonna make a big red chart
      swapRewardPercent: 70, //! Percent distributed
      minGetSol: 0.001,
      buyBackPercent: 20, // 1 = 1%, 10 = 10%
      maxWithdrawpercent: 3,
    },
    rules: {
      minHold: 0.0001,
      ataExist: true,
    },
  });

  distributionRunner.run();
};

run();
