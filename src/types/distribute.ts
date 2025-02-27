import type { Mint } from "@solana/spl-token";
import type { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type Logger from "../services/logger";

/**
 * @params distributionIntervalMinutes Interval between running the distribution - default `5`
 * @params wdAndSwap Include swap fee in each withdraw transaction or swap fee after all withdraw complete - default `false`
 * @params swapFeePercent Percentage of withdraw amount will be swapped into SOL - default `75`
 * @params minGetSol How much minimum SOL balance get from swapping withdraw fee to continue distribution. - default `0.003`
 * @params swapRewardPercent How many percent of SOL from withdraw fee to be swapped into rewards - default `60` (percent)
 * @params minWithdrawPercent How many percent of withdraw fee of total supply to process withdraw - default `0.1` (percent)
 */
export interface RewardDistributionRunnerOptions {
  distributionIntervalMinutes?: number;
  wdAndSwap?: boolean;
  swapFeePercent?: number;
  minGetSol?: number;
  swapRewardPercent?: number;
  minWithdrawPercent?: number;
}

/**
 * This is extending `getMint()` response  from `@solana/spl-token`
 * @params programId Program ID

 */
export interface MintData extends Mint {
  programId: PublicKey;
}

/**
 * @params connection Connection
 * @params heliusAPIKey Helius API Key - https://helius.dev
 * @params mint MintData token
 * @params signer Keypair signer (feeWithheldAuthority)
 * @params rewards Array of RewardsToken
 * @params logger Logger
 * @params options RewardDistributionRunnerOptions
 * @params rules Rules
 */
export interface ConstructorRewardDistributionRunner {
  connection: Connection;
  heliusAPIKey: string;
  mint: MintData;
  signer: Keypair;
  logger?: Logger;
  options?: RewardDistributionRunnerOptions;
  rules?: Rules;
  rewards: RewardsToken[];
}

/**
 * Total of Rewards token must not exceed 100%
 *
 * @params publicKey Token address
 * @params percent Percentage
 * @params programId Token program ID
 * @params name custom name / identifier
 */
export interface RewardsToken {
  publicKey: PublicKey;
  percent: number;
  programId: PublicKey;
  name: string;
}

/**
 * @params minHold Minimum hold token percentage on holder to get distributed - default `0.05` percent
 * @params ataExist If `true` then will create ATA for the recipient, if `false` then only distribute of the ATA is exist.
 */
export interface Rules {
  minHold?: number;
  ataExist?: boolean;
}
