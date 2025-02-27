//TODO Auto Buyback
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  createWithdrawWithheldTokensFromAccountsInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTransferFeeConfig,
  NATIVE_MINT,
  type Mint,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import Logger from "./services/logger";
import { getHolders } from "./helper/holder";
import { isAtaExist } from "./helper/ata";
import { sleep } from "bun";
import type { Pantat } from "./types/pantat";
import { HELIUS_API_KEY, MAINNET } from "../env";
import swap, { swapPantat } from "./swap";
import { Raydium } from "@raydium-io/raydium-sdk-v2";
import { getPoolInfo, type PoolInfo } from "./helper/pool";
import type {
  ConstructorRewardDistributionRunner,
  MintData,
  RewardDistributionRunnerOptions,
  RewardsToken,
  Rules,
} from "./types/distribute";

const defaultRules: Rules = {
  minHold: 0.05,
  ataExist: true,
};

const defaultOptions: RewardDistributionRunnerOptions = {
  distributionIntervalMinutes: 5,
  wdAndSwap: false,
  swapFeePercent: 60,
  minGetSol: 0.05,
  swapRewardPercent: 60,
  maxWithdrawpercent: 0.5, //! Not used yet
};
const mintLiquidityReserveCutPercent = 90;
const balanceLogger = new Logger("balance");
const BASE_FEE = 0.000005;
class RewardDistributionRunner {
  private connection: Connection;
  private heliusRPCURL: string;
  private mint: MintData;
  private ata: PublicKey | null = null;
  private rewards: RewardsToken[];
  private signer: Keypair;
  private logger: Logger;
  private options: RewardDistributionRunnerOptions;
  private rules: Rules;
  private validated = false;
  private raydium: Raydium | null = null;
  private poolInfo: PoolInfo | null = null;
  private snapshotReward: { [key: string]: string } = {};

  constructor(params: ConstructorRewardDistributionRunner) {
    this.connection = params.connection;
    this.heliusRPCURL = `https://${
      MAINNET ? "mainnet" : "devnet"
    }.helius-rpc.com/?api-key=${params.heliusAPIKey}`;
    this.mint = params.mint;
    this.signer = params.signer;
    this.rewards = params.rewards;
    this.logger = params.logger ?? new Logger("dr");
    if (params.options) {
      this.options = { ...defaultOptions, ...params.options };
    } else {
      this.options = { ...defaultOptions };
    }
    if (params.rules) {
      this.rules = { ...defaultRules, ...params.rules };
    } else {
      this.rules = { ...defaultRules };
    }
  }

  private async validateToken() {
    let tokenInfo: Mint;
    try {
      tokenInfo = await getMint(
        this.connection,
        this.mint.address,
        "confirmed",
        this.mint.programId
      );
    } catch (err) {
      this.logger.log({
        level: "error",
        label: "validate",
        message: "Token info not found",
      });
      process.exit();
    }
    try {
      if (!tokenInfo?.tlvData) {
        this.logger.log({
          level: "error",
          label: "validate",
          message: "Catch-Invalid token configuration",
        });
        process.exit();
      }

      const transferFeeLayout = getTransferFeeConfig(tokenInfo);
      if (
        !transferFeeLayout?.withheldAmount &&
        !transferFeeLayout?.olderTransferFee.transferFeeBasisPoints &&
        !transferFeeLayout?.withdrawWithheldAuthority
      ) {
        this.logger.log({
          level: "error",
          label: "validate",
          message: "Invalid token configuration",
        });
        process.exit();
      }
    } catch (err) {
      this.logger.log({
        level: "error",
        label: "validate",
        message: "Catch-Invalid token fee configuration",
      });
      process.exit();
    }

    return tokenInfo;
  }

  private async validateRequiredData() {
    console.clear();
    if (!HELIUS_API_KEY) {
      this.logger.log({
        level: "error",
        label: "env",
        message: `HELIUS_API_KEY not set on .env`,
      });
      process.exit();
    }
    if (MAINNET) {
      this.logger.log({
        level: "warn",
        label: "cluster",
        message: `Running on mainnet.`,
      });
    } else {
      this.logger.log({
        level: "verbose",
        label: "cluster",
        message: `Running on devnet.`,
      });
    }
    const tokenInfo = await this.validateToken();
    const totalPercentageReward = this.rewards.reduce(
      (a, b) => (a += b.percent),
      0 as number
    );
    if (totalPercentageReward > 100) {
      this.logger.log({
        level: "error",
        label: "reward",
        message: `Percentage reward total ${totalPercentageReward}% exceeds 100%. `,
      });
      process.exit();
    }
    if (this.options.swapFeePercent! > 100) {
      this.logger.log({
        level: "error",
        label: "reward",
        message: `Swap fee percent (${this.options.swapFeePercent})% exceeds 100%. `,
      });
      process.exit();
    }

    //* Validate rewards mint
    for await (const reward of this.rewards.filter(
      (r) => r.publicKey.toString() != NATIVE_MINT.toString()
    )) {
      try {
        await getMint(
          this.connection,
          reward.publicKey,
          "confirmed",
          reward.programId
        );
      } catch (err) {
        this.logger.log({
          level: "error",
          label: "validate",
          message: `Rewards ${reward.name} invalid. ${err}`,
        });
        process.exit();
      }
    }
    const transferFeeConfig = getTransferFeeConfig(tokenInfo);
    if (
      !transferFeeConfig?.withheldAmount &&
      !transferFeeConfig?.olderTransferFee.transferFeeBasisPoints &&
      !transferFeeConfig?.withdrawWithheldAuthority
    ) {
      this.logger.log({
        level: "error",
        label: "validate",
        message: "Transfer fee not detected on token",
      });
      process.exit();
    }
    if (
      transferFeeConfig?.withdrawWithheldAuthority.toBase58() !=
      this.signer.publicKey.toBase58()
    ) {
      this.logger.log({
        level: "error",
        label: "validate",
        message: `Fee receiver not same, expected ${transferFeeConfig?.withdrawWithheldAuthority.toBase58()}`,
      });
      process.exit();
    }
    const feeAuthorityBalance = await this.connection.getBalance(
      this.signer.publicKey
    );
    if (
      !feeAuthorityBalance ||
      feeAuthorityBalance <
        this.rewards.filter(
          (reward) => reward.publicKey.toString() != NATIVE_MINT.toString()
        ).length *
          0.0023
    ) {
      this.logger.log({
        level: "error",
        label: "validate",
        message: `Fee authority have ${(
          feeAuthorityBalance / LAMPORTS_PER_SOL
        ).toFixed(5)} SOL. Need at least ${
          this.rewards.filter(
            (reward) => reward.publicKey.toString() != NATIVE_MINT.toString()
          ).length * 0.0023
        }`,
      });
      process.exit();
    } else {
      const minFeeAccountBalance = 0.003;
      if (feeAuthorityBalance < minFeeAccountBalance * LAMPORTS_PER_SOL) {
        this.logger.log({
          level: "warn",
          label: "validate",
          message: `Account less than ${minFeeAccountBalance} SOL`,
        });
        process.exit();
      }

      this.logger.log({
        level: "verbose",
        label: "account",
        message: `Fee authority balance: ${(
          feeAuthorityBalance / LAMPORTS_PER_SOL
        ).toFixed(5)} SOL`,
      });
    }

    if (this.raydium == null) {
      this.raydium = await Raydium.load({
        owner: this.signer,
        connection: this.connection,
        cluster: MAINNET ? "mainnet" : "devnet",
        disableFeatureCheck: true,
        blockhashCommitment: "confirmed",
      });
    }
    const poolInfo = await getPoolInfo({
      raydium: this.raydium,
      tokenA: this.mint.address,
      tokenB: NATIVE_MINT,
    });
    if (!poolInfo) {
      this.logger.log({
        level: "error",
        label: "poolInfo",
        message: `Unable to fetch poolInfo mint token.`,
      });
      process.exit();
    }
    // Validate rewards mint poolInfo
    for await (const reward of this.rewards.filter(
      (r) => r.publicKey.toString() != NATIVE_MINT.toString()
    )) {
      const poolInfo = await getPoolInfo({
        raydium: this.raydium,
        tokenA: NATIVE_MINT,
        tokenB: reward.publicKey,
      });
      if (!poolInfo) {
        this.logger.log({
          level: "error",
          label: "validate",
          message: `Unable to get pool info reward token ${reward.name}`,
        });
        process.exit();
      }
    }

    this.poolInfo = poolInfo;

    // Validate ata rewards and mint
    const txsCreateAta = [];
    const ifMintAtaExist = await isAtaExist(this.connection, this._getAta());
    if (!ifMintAtaExist) {
      txsCreateAta.push(
        createAssociatedTokenAccountInstruction(
          this.signer.publicKey,
          this._getAta(),
          this.signer.publicKey,
          this.mint.address,
          this.mint.programId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    await sleep(2000);
    for await (const reward of this.rewards.filter(
      (r) => r.publicKey.toString() != NATIVE_MINT.toString()
    )) {
      try {
        const rewardAta = getAssociatedTokenAddressSync(
          reward.publicKey,
          this.signer.publicKey,
          false,
          reward.programId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
        const rewardAtaExist = await isAtaExist(this.connection, rewardAta);
        if (!rewardAtaExist) {
          this.logger.log({
            level: "info",
            label: "validate",
            message: `Creating ATA for ${reward.name}`,
          });
          txsCreateAta.push(
            createAssociatedTokenAccountInstruction(
              this.signer.publicKey,
              rewardAta,
              this.signer.publicKey,
              reward.publicKey,
              reward.programId,
              ASSOCIATED_TOKEN_PROGRAM_ID
            )
          );
        }
      } catch (err) {
        console.error(err);
        this.logger.log({
          level: "error",
          label: "validate",
          message: `Something wrong on get or Create Ata for reward token ${reward.name}`,
        });
        process.exit();
      }
      await sleep(1000);
    }
    // Sending Tx Create ata
    if (txsCreateAta.length > 0) {
      try {
        const createATATxMessage = new TransactionMessage({
          payerKey: this.signer.publicKey,
          recentBlockhash: (await this.connection.getLatestBlockhash())
            .blockhash,
          instructions: txsCreateAta,
        }).compileToV0Message();
        const createATAVersioned = new VersionedTransaction(createATATxMessage);
        createATAVersioned.sign([this.signer]);
        await this.connection.sendTransaction(createATAVersioned);
        this.logger.log({
          level: "info",
          label: "validate",
          message: `Success send tx create ATA for mint and rewards`,
        });
      } catch (err) {
        console.error(err);
        this.logger.log({
          level: "error",
          label: "validate",
          message: `Something wrong on sending create ATA for reward tokens and mint`,
        });
        process.exit();
      }
    }

    //* Done
    this.validated = true;
    this.logger.log({
      level: "info",
      label: "validate",
      message: `Validation passed.`,
    });

    await sleep(2000);
  }
  private getWithdrawAbleTokenAccounts(listHolders: Pantat[]) {
    let holders = [...listHolders];
    let wdAmount = holders.splice(0, 1)[0]?.withheld_amount ?? 0;
    let results = [];
    const maxPercent = this.options.maxWithdrawpercent!;
    for (const holder of holders) {
      const percentage = this.getHolderPercentage(
        wdAmount + holder.withheld_amount
      );
      if (percentage <= maxPercent) {
        results.push(holder);
        wdAmount += holder.withheld_amount;
      }
      const final = this.getHolderPercentage(wdAmount);
      if (final >= maxPercent) break;
    }

    return results;
  }
  private async withdrawFee(
    mint: Mint,
    receiver: Keypair,
    tokenAccounts: PublicKey[]
  ) {
    let totalWithdrawed = 0;
    const limit = this.options.wdAndSwap == true ? 15 : 24;
    const estTotalTx = Math.ceil(tokenAccounts.length / limit);
    this.logger.log({
      level: "verbose",
      label: "withdraw",
      message: `Remaining token accounts ${tokenAccounts.length}, Estimated total TX: ${estTotalTx}`,
    });

    const ata = this._getAta();
    let preparedAccs = [...tokenAccounts];
    while (preparedAccs.length > 0) {
      const wd = await this._withdrawFee(
        mint,
        ata,
        receiver,
        preparedAccs.splice(0, limit)
      );
      totalWithdrawed += wd.withdrawAmount;
      preparedAccs.push(...wd.remaining);
      await sleep(2000);
    }

    const denom = 10 ** mint.decimals;
    this.logger.log({
      level: "verbose",
      label: "withdraw",
      message: `Withdraw done, total withdrawed ${totalWithdrawed / denom} `,
    });

    return totalWithdrawed;
  }

  private calculateWithdrawFeeToSolLamports(
    amountToken: number,
    poolInfo: PoolInfo
  ) {
    return amountToken / poolInfo?.poolPrice!;
  }
  private calculateMintAmountOutFromSOL(amountSOL: number) {
    return amountSOL * this.poolInfo!.poolPrice!;
  }
  private calculateSOLNeededToPerformWithdraw(totalHolders: number) {
    const limit = this.options.wdAndSwap == true ? 15 : 24;
    const estimatedTotalWithdrawTx = Math.ceil(totalHolders / limit);
    const realTxFee = BASE_FEE * 10;
    return realTxFee * estimatedTotalWithdrawTx * LAMPORTS_PER_SOL;
  }
  private calculateSOLNeededToPerformDistribute(
    holders: Pantat[],
    solGet: number
  ) {
    // Fee swapping rewards
    const swapRewardFee = BASE_FEE * 10;
    const nonNativeRewards = this.rewards.filter(
      (reward) => reward.publicKey.toString() != NATIVE_MINT.toString()
    );
    const totalSwapRewardFee =
      swapRewardFee * nonNativeRewards.length * LAMPORTS_PER_SOL;

    // SOL Needed for native rewards
    let sentSol = 0;
    const nativeReward = this.rewards.filter(
      (reward) => reward.publicKey.toString() == NATIVE_MINT.toString()
    );
    if (nativeReward.length > 0) {
      const holdersGetByPercentage = holders.map((holder) => {
        const holderPercentage = this.getHolderPercentage(holder.amount);
        const amount = this.calculateAmount(
          Number(solGet),
          holderPercentage,
          nativeReward[0].percent
        );
        return amount;
      });
      sentSol = holdersGetByPercentage.reduce((a, b) => a + b, 0);
    }

    const limitDividerByRewards = this.rewardDivider();
    const instructionsSingleTx = 24 / limitDividerByRewards;
    const estimatedTotalDistributeTx = Math.ceil(
      holders.length / instructionsSingleTx
    );
    const realTxFee = BASE_FEE * 10;
    const totalDistributeFee =
      realTxFee * estimatedTotalDistributeTx * LAMPORTS_PER_SOL;

    let totalEstimateFeeCreateATA = 0;
    if (this.rules.ataExist == false) {
      const estimateNotHaveAta = Math.floor((75 * instructionsSingleTx) / 100);
      const feeCreateAta = 0.0023;
      const estimateCreateAta =
        estimateNotHaveAta * feeCreateAta * nonNativeRewards.length;
      totalEstimateFeeCreateATA = estimateCreateAta * LAMPORTS_PER_SOL;
    }
    return (
      totalDistributeFee +
      totalSwapRewardFee +
      sentSol +
      totalEstimateFeeCreateATA
    );
  }
  private async _simulateWithdrawFee(
    mint: Mint,
    ataReceiver: PublicKey,
    receiver: Keypair,
    tokenAccounts: PublicKey[],
    remaining: PublicKey[] = []
  ): Promise<{
    withdrawAmount: number;
    remaining: PublicKey[];
  }> {
    const ata = ataReceiver;
    const ifAtaExist = await isAtaExist(this.connection, ata);
    let totalFee = BASE_FEE;
    let txs = [];
    if (!ifAtaExist) {
      totalFee += 0.0025;
      txs.push(
        createAssociatedTokenAccountInstruction(
          receiver.publicKey,
          ata,
          receiver.publicKey,
          mint.address,
          this.mint.programId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }
    txs.push(
      createWithdrawWithheldTokensFromAccountsInstruction(
        mint.address,
        ata,
        receiver.publicKey,
        [],
        tokenAccounts,
        this.mint.programId
      )
    );
    let initialBalance = -1;
    try {
      const bal = await getAccount(
        this.connection,
        ata,
        "confirmed",
        this.mint.programId
      );
      initialBalance = Number(bal.amount);
    } catch (err) {}

    //* Single TX
    let { blockhash } = await this.connection.getLatestBlockhash();
    const tx = new TransactionMessage({
      payerKey: receiver.publicKey,
      recentBlockhash: blockhash,
      instructions: txs,
    }).compileToV0Message();
    try {
      const txMessageBytes = tx.serialize();
      if (txMessageBytes.length > 1232) {
        throw new Error("max bytes");
      }
    } catch (err) {
      const remainingAddress = tokenAccounts.splice(0, 1);
      return await this._simulateWithdrawFee(
        mint,
        ataReceiver,
        receiver,
        tokenAccounts,
        remainingAddress
      );
    }
    const versionedTx = new VersionedTransaction(tx);
    versionedTx.sign([receiver]);
    try {
      const vtxMessageBytes = versionedTx.serialize();
      if (vtxMessageBytes.length > 1232) {
        throw new Error("max bytes");
      }
    } catch (err) {
      const remainingAddress = tokenAccounts.splice(0, 1);
      return await this._simulateWithdrawFee(
        mint,
        ataReceiver,
        receiver,
        tokenAccounts,
        remainingAddress
      );
    }
    await sleep(1000);
    const simulateTx = await this.connection.simulateTransaction(versionedTx, {
      replaceRecentBlockhash: true,
      accounts: {
        encoding: "base64",
        addresses: [ata.toBase58()],
      },
    });
    if (!simulateTx.value.err) {
      if (!simulateTx.value.accounts![0]?.data[0]) {
        return { withdrawAmount: 0, remaining };
      }
      const afterSimulate = AccountLayout.decode(
        Buffer.from(simulateTx.value.accounts![0]?.data[0]!, "base64")
      );

      if (
        initialBalance > -1 &&
        initialBalance == Number(afterSimulate.amount)
      ) {
        return { withdrawAmount: 0, remaining };
      }

      const withdrawAmount = Number(afterSimulate.amount) - initialBalance;
      const solFromWD = this.calculateWithdrawFeeToSolLamports(
        withdrawAmount,
        this.poolInfo!
      );
      await sleep(500);

      if (this.options.wdAndSwap != true) {
        return {
          remaining,
          withdrawAmount: solFromWD - totalFee * LAMPORTS_PER_SOL,
        };
      }
      totalFee += BASE_FEE;
      return {
        withdrawAmount: solFromWD - totalFee * LAMPORTS_PER_SOL,
        remaining,
      };
    }
    return { withdrawAmount: 0, remaining };
  }
  private async simulateWithdrawFee(
    mint: Mint,
    receiver: Keypair,
    tokenAccounts: PublicKey[]
  ) {
    let totalWithdrawed = 0;
    const limit = this.options.wdAndSwap == true ? 15 : 24;
    const estTotalTx = Math.ceil(tokenAccounts.length / limit);
    this.logger.log({
      level: "verbose",
      label: "withdraw",
      message: `Token accounts ${tokenAccounts.length} -- Est Txs: ${estTotalTx}`,
    });
    const ata = this._getAta();
    let preparedAccs = [...tokenAccounts];
    while (preparedAccs.length > 0) {
      const wd = await this._simulateWithdrawFee(
        mint,
        ata,
        receiver,
        preparedAccs.splice(0, limit)
      );
      totalWithdrawed += wd.withdrawAmount;
      preparedAccs.push(...wd.remaining);
      await sleep(1000);
    }
    return totalWithdrawed;
  }
  private async _withdrawFee(
    mint: Mint,
    ataReceiver: PublicKey,
    receiver: Keypair,
    tokenAccounts: PublicKey[],
    remaining: PublicKey[] = []
  ): Promise<{
    withdrawAmount: number;
    remaining: PublicKey[];
  }> {
    await sleep(2500);

    const ata = ataReceiver;
    const ifAtaExist = await isAtaExist(this.connection, ata);
    let txs = [];
    if (!ifAtaExist) {
      this.logger.log({
        level: "warn",
        label: "withdraw",
        message: `ATA Not found.`,
      });
      txs.push(
        createAssociatedTokenAccountInstruction(
          receiver.publicKey,
          ata,
          receiver.publicKey,
          mint.address,
          this.mint.programId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    }

    txs.push(
      createWithdrawWithheldTokensFromAccountsInstruction(
        mint.address,
        ata,
        receiver.publicKey,
        [],
        tokenAccounts,
        this.mint.programId
      )
    );

    let initialBalance = -1;
    try {
      await sleep(2000);
      const bal = await getAccount(
        this.connection,
        ata,
        "confirmed",
        this.mint.programId
      );
      initialBalance = Number(bal.amount);
    } catch (err) {}

    //* Single TX
    let { blockhash } = await this.connection.getLatestBlockhash();
    const tx = new TransactionMessage({
      payerKey: receiver.publicKey,
      recentBlockhash: blockhash,
      instructions: txs,
    }).compileToV0Message();
    try {
      const txMessageBytes = tx.serialize();
      if (txMessageBytes.length > 1232) {
        throw new Error("max bytes");
      }
    } catch (err) {
      const remainingAddress = tokenAccounts.splice(0, 1);
      return await this._withdrawFee(
        mint,
        ataReceiver,
        receiver,
        tokenAccounts,
        remainingAddress
      );
    }
    const versionedTx = new VersionedTransaction(tx);
    versionedTx.sign([receiver]);
    try {
      const vtxMessageBytes = versionedTx.serialize();
      if (vtxMessageBytes.length > 1232) {
        throw new Error("max bytes");
      }
    } catch (err) {
      const remainingAddress = tokenAccounts.splice(0, 1);
      return await this._withdrawFee(
        mint,
        ataReceiver,
        receiver,
        tokenAccounts,
        remainingAddress
      );
    }
    await sleep(1000);
    const simulateTx = await this.connection.simulateTransaction(versionedTx, {
      replaceRecentBlockhash: true,
      accounts: {
        encoding: "base64",
        addresses: [ata.toBase58()],
      },
    });
    if (!simulateTx.value.err) {
      if (!simulateTx.value.accounts![0]?.data[0]) {
        console.error({ simulateTx });
        this.logger.log({
          level: "warn",
          label: "withdraw",
          message: `Something error while simulate withdrawFee`,
        });
        return { withdrawAmount: 0, remaining };
      }
      const afterSimulate = AccountLayout.decode(
        Buffer.from(simulateTx.value.accounts![0]?.data[0]!, "base64")
      );

      if (
        initialBalance > -1 &&
        initialBalance == Number(afterSimulate.amount)
      ) {
        this.logger.log({
          level: "warn",
          label: "withdraw",
          message: `No balance changes. skipping...`,
        });
        return { withdrawAmount: 0, remaining };
      }
      const afterSimulatePercent =
        (Number(afterSimulate.amount) * 100) / Number(this.mint.supply);

      const withdrawAmount = Number(afterSimulate.amount) - initialBalance;
      await sleep(500);
      const sigwd = await this.connection.sendTransaction(versionedTx);

      if (this.options.wdAndSwap != true) {
        this.logger.log({
          level: "info",
          label: "withdraw",
          message: `Gain +${(withdrawAmount / 10 ** mint.decimals).toFixed(
            5
          )} (${afterSimulatePercent.toFixed(4)}%) tokens from ${
            tokenAccounts.length
          } accounts. Signature => ${sigwd.split("").slice(0, 10).join("")}`,
        });
        return { remaining, withdrawAmount };
      }

      // If withdraw & swap in one tx
      const swapAmount = Math.round(
        (withdrawAmount * this.options.swapFeePercent!) / 100
      );
      const swapTx = await this._swapFee(swapAmount);
      const withdrawAndSwap = new TransactionMessage({
        payerKey: receiver.publicKey,
        recentBlockhash: blockhash,
        instructions: [...txs, ...swapTx.instructions],
      }).compileToV0Message();
      try {
        const withdrawAndSwapBytes = withdrawAndSwap.serialize();
        if (withdrawAndSwapBytes.length > 1232) {
          throw new Error("max bytes");
        }
      } catch (err) {
        const remainingAddress = tokenAccounts.splice(0, 1);
        this.logger.log({
          level: "warn",
          label: "tx",
          message: `Max bytes exceed, recomposing transactions.`,
        });

        return await this._withdrawFee(
          mint,
          ataReceiver,
          receiver,
          tokenAccounts,
          remainingAddress
        );
      }
      const versionedWithdrawAndSwapTx = new VersionedTransaction(
        withdrawAndSwap
      );
      versionedWithdrawAndSwapTx.sign([receiver]);
      try {
        const versionedWithdrawAndSwapTxBytes =
          versionedWithdrawAndSwapTx.serialize();
        if (versionedWithdrawAndSwapTxBytes.length > 1232) {
          throw new Error("max bytes");
        }
      } catch (err) {
        const remainingAddress = tokenAccounts.splice(0, 1);
        this.logger.log({
          level: "warn",
          label: "tx",
          message: `Max bytes exceed, recomposing transactions.`,
        });

        return await this._withdrawFee(
          mint,
          ataReceiver,
          receiver,
          tokenAccounts,
          remainingAddress
        );
      }
      const simulateWithdrawAndSwapTx =
        await this.connection.simulateTransaction(versionedWithdrawAndSwapTx, {
          replaceRecentBlockhash: true,
          accounts: {
            encoding: "base64",
            addresses: [ata.toBase58()],
          },
        });
      if (simulateWithdrawAndSwapTx.value.err) {
        console.error({ simulateWithdrawAndSwapTx });
        process.exit();
      }

      const sig = await this.connection.sendTransaction(
        versionedWithdrawAndSwapTx
      );
      this.logger.log({
        level: "info",
        label: "withdraw",
        message: `Gain +${
          withdrawAmount / 10 ** mint.decimals
        } tokens from withdraw. at => ${sig} and swapped ${swapAmount}`,
      });
      return { withdrawAmount, remaining };
    }
    console.log({ simulateTx });
    console.error(`Error while simulating withdrawFee`);
    process.exit(1);
  }

  private async distribute(
    feeAuthority: Keypair,
    mint: Mint,
    holders: Pantat[],
    queuePosition: number,
    totalQueue: number,
    solGet: number,
    unprocessed: Pantat[] = []
  ): Promise<Pantat[]> {
    holders = holders.filter(
      (obj, index, self) =>
        index ===
        self.findIndex(
          (o) => o.owner.toLowerCase().trim() === obj.owner.toLowerCase().trim()
        )
    );
    const globalTxs = [];
    for await (const holder of holders) {
      const holderPercentage = this.getHolderPercentage(holder.amount);

      for await (const reward of this.rewards) {
        try {
          const ata = getAssociatedTokenAddressSync(
            reward.publicKey,
            feeAuthority.publicKey,
            false,
            reward.programId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );
          const recipient = new PublicKey(holder.owner);
          if (
            reward.publicKey.toString().trim() == NATIVE_MINT.toString().trim()
          ) {
            const amount = this.calculateAmount(
              (solGet * 50) / 100,
              holderPercentage,
              95
            );
            this.logger.log({
              level: "silly",
              label: "distribute",
              message: `Distributed ${(amount / LAMPORTS_PER_SOL).toFixed(
                9
              )} SOL to (${holder.address
                .toString()
                .split("")
                .slice(0, 10)
                .join("")}) with ${holderPercentage.toFixed(3)}%`,
            });
            this.logger.log({
              level: "silly",
              label: "distribute",
              message: `WDSOL ${solGet} - Holder ${holderPercentage.toFixed(
                3
              )}% - Reduced: ${amount}`,
            });
            globalTxs.push(
              SystemProgram.transfer({
                fromPubkey: this.signer.publicKey,
                toPubkey: recipient,
                lamports: amount,
              })
            );
          } else {
            const r = reward.publicKey;
            const balanceReward =
              this.snapshotReward[r.toString().toLowerCase().trim()];
            try {
              const ataRecipient = getAssociatedTokenAddressSync(
                r,
                recipient,
                false,
                reward.programId,
                ASSOCIATED_TOKEN_PROGRAM_ID
              );

              const ataExists = await isAtaExist(this.connection, ataRecipient);
              if (
                balanceReward &&
                (ataExists || this.rules.ataExist == false)
              ) {
                let amount = this.calculateAmount(
                  Number(balanceReward),
                  holderPercentage,
                  98 //! Test, supposed to 100
                );
                if (!ataExists) {
                  const createATAFeeByMint =
                    this.calculateMintAmountOutFromSOL(0.0023);
                  const reducedHolderAmount =
                    holder.amount - createATAFeeByMint;
                  if (reducedHolderAmount > 0) {
                    // Reduce amount by 0.0023 SOL (ATA CREATION)
                    const reducedPercentage =
                      this.getHolderPercentage(reducedHolderAmount);
                    amount = this.calculateAmount(
                      Number(balanceReward),
                      reducedPercentage,
                      80
                    );
                    this.logger.log({
                      level: "silly",
                      label: "distribute",
                      message: `Creating ATA token ${
                        reward.name
                      } for ${ataRecipient
                        .toBase58()
                        .split("")
                        .slice(0, 5)
                        .join("")}`,
                    });
                    globalTxs.push(
                      createAssociatedTokenAccountIdempotentInstruction(
                        this.signer.publicKey,
                        ataRecipient,
                        recipient,
                        r,
                        reward.programId,
                        ASSOCIATED_TOKEN_PROGRAM_ID
                      )
                    );
                  } else {
                    this.logger.log({
                      level: "warn",
                      label: "distribute",
                      message: `Skip Create ATA ${
                        reward.name
                      } for ${ataRecipient
                        .toBase58()
                        .split("")
                        .slice(0, 5)
                        .join(
                          ""
                        )}. Reduced holder amount ${reducedHolderAmount.toFixed(
                        5
                      )} tokens`,
                    });
                  }
                } else {
                  globalTxs.push(
                    createTransferCheckedInstruction(
                      ata,
                      r,
                      ataRecipient,
                      feeAuthority.publicKey,
                      amount,
                      mint.decimals,
                      [],
                      reward.programId
                    )
                  );

                  this.logger.log({
                    level: "silly",
                    label: "distribute",
                    message: `Distributed ${
                      amount / 10 ** this.mint.decimals
                    } ${reward.name} to ${ataRecipient
                      .toBase58()
                      .split("")
                      .slice(0, 5)
                      .join("")} with ${holderPercentage.toFixed(3)}%`,
                  });
                }
              } else {
                if (!balanceReward) {
                  this.logger.log({
                    level: "warn",
                    label: "distribute",
                    message: `No snapshot for reward ${reward.name}`,
                  });
                } else {
                  this.logger.log({
                    level: "warn",
                    label: "distribute",
                    message: `ATA recipient not exists. Skipped.`,
                  });
                }
              }
            } catch (err) {
              this.logger.log({
                level: "warn",
                label: "distribute",
                message: `Skip distributing ${reward.name} to ${holder.address
                  .split("")
                  .slice(0, 10)
                  .join("")}.`,
              });
            }
          }
        } catch (err) {
          console.log({ err });
        }
        await sleep(50);
      }
      await sleep(50);
    }
    if (globalTxs.length == 0) {
      return unprocessed;
    }
    const tx = new TransactionMessage({
      payerKey: this.signer.publicKey,
      recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
      instructions: [...globalTxs],
    }).compileToV0Message();

    try {
      const serializedTx = tx.serialize();
      if (serializedTx.length > 1232) {
        throw Error("serialize error");
      }
    } catch (err) {
      const remaining = holders.splice(0, 1);

      this.logger.log({
        level: "warn",
        label: "distribute",
        message: `Recomposing transaction due exceed max bytes limit. Remaining: ${remaining.length}`,
      });
      return await this.distribute(
        feeAuthority,
        mint,
        holders,
        queuePosition,
        totalQueue,
        solGet,
        remaining
      );
    }
    const versionedTx = new VersionedTransaction(tx);
    versionedTx.sign([this.signer]);
    let serializedVTx;
    try {
      serializedVTx = versionedTx.serialize();
      if (serializedVTx.length > 1232) {
        throw Error("serialize error");
      }
    } catch (err) {
      const remaining = holders.splice(0, 1);

      this.logger.log({
        level: "warn",
        label: "distribute",
        message: `Recomposing transaction due exceed max bytes limit. Remaining: ${remaining.length}`,
      });
      return await this.distribute(
        feeAuthority,
        mint,
        holders,
        queuePosition,
        totalQueue,
        solGet,
        remaining
      );
    }
    const simulateTx = await this.connection.simulateTransaction(versionedTx);
    if (!simulateTx.value.err) {
      const sig = await this.connection.sendTransaction(versionedTx);
      if (sig) {
        this.logger.log({
          level: "info",
          label: "distribute",
          message: `Distributed to ${holders.length} accounts. (${
            globalTxs.length
          } IX -- ${serializedVTx.length} bytes) sig: ...${sig
            .split("")
            .splice(-8)
            .join("")} - [${queuePosition + 1}]`,
        });
      } else {
        this.logger.log({
          level: "error",
          label: "distribute",
          message: `Fail distributing to ${holders.length} accounts. `,
        });
      }
    } else {
      unprocessed.push(...holders);
      this.logger.log({
        level: "error",
        label: "distribute",
        message: `Simulate distribute error`,
      });
    }
    return unprocessed;
  }

  private _getAta() {
    if (!this.ata) {
      this.ata = getAssociatedTokenAddressSync(
        this.mint.address,
        this.signer.publicKey,
        false,
        this.mint.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
    }
    return this.ata;
  }

  private async _swapFee(amountToSwap: number) {
    try {
      const swapTx = await swap(
        this.raydium!,
        this.mint.address,
        NATIVE_MINT,
        amountToSwap
      );

      return swapTx;
    } catch (err) {
      return { instructions: [] };
    }
  }

  private async revalidate() {
    this.logger.log({
      level: "verbose",
      label: "revalidate",
      message: `Revalidating poolInfo.`,
    });
    const poolInfo = await getPoolInfo({
      raydium: this.raydium!,
      tokenA: this.mint.address,
      tokenB: NATIVE_MINT,
    });
    if (poolInfo) this.poolInfo = poolInfo;
    this._resetSnapshotReward();
  }

  private async _swapReward(patokanAmountSol: number) {
    const swapAbleRewards = this.rewards.filter(
      (r) => r.publicKey.toString() != NATIVE_MINT.toString()
    );
    if (swapAbleRewards.length == 0) {
      return;
    }

    const txsSwap = [];
    for await (const reward of swapAbleRewards) {
      const amountToSwap = (patokanAmountSol * reward.percent) / 100;
      this.logger.log({
        level: "info",
        label: "reward",
        message: `Swapping to reward ${amountToSwap.toFixed(5)}`,
      });
      if (amountToSwap >= 0) {
        try {
          //! SwapPantat
          const swapTx = await swapPantat(
            this.raydium!,
            NATIVE_MINT,
            reward.publicKey,
            amountToSwap
          );
          const tx = new TransactionMessage({
            payerKey: this.signer.publicKey,
            recentBlockhash: (await this.connection.getLatestBlockhash())
              .blockhash,
            instructions: [...swapTx.instructions],
          }).compileToV0Message();
          const versionedTx = new VersionedTransaction(tx);
          versionedTx.sign([this.signer]);
          await sleep(2000);
          const simulateTx = await this.connection.simulateTransaction(
            versionedTx
          );
          if (!simulateTx.value.err) {
            txsSwap.push(...swapTx.instructions);
          } else {
            this.logger.log({
              level: "error",
              label: "swap-reward",
              message: `Skipping swap reward ${
                reward.name
              }, because: ${JSON.stringify(simulateTx.value.err)}`,
            });
          }
        } catch (err) {
          console.log({ err });
          this.logger.log({
            level: "error",
            label: "swap-reward",
            message: `Skipping swap reward ${reward.name}`,
          });
        }
      } else {
        this.logger.log({
          level: "warn",
          label: "swap-reward",
          message: `Swapping reward ${amountToSwap} tokens. Skipping...`,
        });
      }
      await sleep(2000);
    }
    const tx = new TransactionMessage({
      payerKey: this.signer.publicKey,
      recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
      instructions: [...txsSwap],
    }).compileToV0Message();
    const versionedTx = new VersionedTransaction(tx);
    versionedTx.sign([this.signer]);
    const sign = await this.connection.sendTransaction(versionedTx);
    this.logger.log({
      level: "verbose",
      label: "swap-reward",
      message: `Success swap ${this.rewards.length} rewards on => ${sign
        .toString()
        .split("")
        .slice(-8)
        .join("")}}`,
    });
    await sleep(2500);
  }

  private async swapFee(amount: number) {
    if (amount == 0) {
      this.logger.log({
        level: "warn",
        label: "fee",
        message: `Swapping token fee skipped due to amount ${amount}`,
      });

      return;
    }
    const swapIxs = await this._swapFee(amount);
    if (swapIxs.instructions.length == 0) {
      this.logger.log({
        level: "warn",
        label: "fee",
        message: `Canceling swap due to very low swap-amount`,
      });
      return;
    }
    const newTxMessage = new TransactionMessage({
      payerKey: this.signer.publicKey,
      recentBlockhash: (await this.connection.getLatestBlockhash()).blockhash,
      instructions: [...swapIxs.instructions],
    }).compileToV0Message();
    const versionedTx = new VersionedTransaction(newTxMessage);
    versionedTx.sign([this.signer]);
    try {
      const simulateTx = await this.connection.simulateTransaction(versionedTx);
      if (simulateTx.value.err)
        throw new Error(simulateTx.value.err.toString());
    } catch (err) {
      this.logger.log({
        level: "error",
        label: "fee",
        message: `Swapping token fee skipped, failed due ${err}`,
      });
      return;
    }
    const initialBalance = await this.connection.getBalance(
      this.signer.publicKey
    );
    await sleep(2500);
    await this.connection.sendTransaction(versionedTx);
    await sleep(2500);
    const afterBalance = await this.connection.getBalance(
      this.signer.publicKey
    );

    this.logger.log({
      level: "verbose",
      label: "fee",
      message: `Token fee ${(amount / 10 ** this.mint.decimals).toFixed(
        5
      )} swapped to ${(
        (afterBalance - initialBalance) /
        LAMPORTS_PER_SOL
      ).toFixed(5)} SOL`,
    });
    return;
  }

  private async _resetSnapshotReward() {
    const rewards: {
      [key: string]: string;
    } = {};
    for (const reward of this.rewards) {
      const key = reward.publicKey.toString().toLowerCase();
      rewards[key] = "0";
    }
  }

  private async _getSnapshotReward() {
    const rewards: {
      [key: string]: string;
    } = {};
    this.logger.log({
      level: "info",
      label: "reward",
      message: `Getting snapshot...`,
    });
    for (const reward of this.rewards.filter(
      (reward) => reward.publicKey.toString() != NATIVE_MINT.toString()
    )) {
      const ata = getAssociatedTokenAddressSync(
        reward.publicKey,
        this.signer.publicKey,
        false,
        reward.programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const balance = await this.connection.getTokenAccountBalance(ata);
      rewards[reward.publicKey.toString().toLowerCase()] = (
        (Number(balance.value.amount) * 97) /
        100
      ).toString();
    }
    this.snapshotReward = rewards;
    this.logger.log({
      level: "info",
      label: "reward",
      message: `Snapshot done`,
    });
  }

  private rewardDivider() {
    const rewards = this.rewards.flatMap((reward) =>
      reward.publicKey.toString()
    );
    const nonNative = rewards.filter((r) => r != NATIVE_MINT.toString());
    const gap = this.rewards.length * 1.2;
    const total = gap + nonNative.length;
    return Math.floor(total);
  }

  private getHolderPercentage(holderAmount: number) {
    const cutRules = mintLiquidityReserveCutPercent / 100;

    let basePercentage = (holderAmount * 100) / Number(this.mint.supply);
    return Number((basePercentage * cutRules).toFixed(4));
  }

  private calculateAmount(
    amount: number,
    holderPercentage: number,
    rewardPercent: number
  ) {
    // const feeConfig = getTransferFeeConfig(this.mint);
    // const feePercentBasis =
    //   feeConfig?.newerTransferFee.transferFeeBasisPoints ?? 500;
    // const feePercent = feePercentBasis / 100 / 100;
    //* Mint fee percentage
    //! Test no cut
    // amount = amount * feePercent;

    //* Hold percentage
    amount = (amount * holderPercentage) / 100;

    //* Reward percentage
    // let rewardPercentReduce = (amount * rewardPercent) / 100;
    // amount = amount - rewardPercentReduce;
    amount = (amount * rewardPercent) / 100;

    //* Pool fee
    const poolFee = this.poolInfo?.poolInfo.feeRate ?? 2500;
    const poolFeeAmount = (amount * poolFee) / 100 / 100;
    amount = amount - poolFeeAmount;

    return Math.floor(amount);
  }

  public async run(): Promise<void> {
    if (!this.validated) {
      await this.validateRequiredData();
    } else {
      await this.revalidate();
    }

    const startBalance = await this.connection.getBalance(
      this.signer.publicKey
    );

    this.logger.log({
      level: "info",
      label: "signer",
      message: `Signer balance ${(startBalance / LAMPORTS_PER_SOL).toFixed(
        5
      )} SOL`,
    });

    this.logger.log({
      level: "info",
      label: "signer",
      message: `Swap WD: ${this.options
        .swapFeePercent!}% - Distribute percent: ${
        this.options.swapRewardPercent
      } - Min Hold ${this.rules.minHold}%`,
    });

    // Preparing holders
    let listHolders = (
      await getHolders(
        this.mint.address.toBase58(),
        this.heliusRPCURL,
        this.logger
      )
    ).filter((holder) => {
      //! Exclude POOL LP
      return (
        holder.owner.toString() != this.poolInfo?.poolKeys.authority.toString()
      );
    });
    //!Test new holders
    const listWithdrawAbleHolders = this.getWithdrawAbleTokenAccounts(
      listHolders
        .filter((holder) => holder.withheld_amount > 0)
        .sort((a, b) => b.withheld_amount - a.withheld_amount)
    );
    const filteredHolders = listHolders.filter((h) => {
      const holderPercentage = this.getHolderPercentage(h.amount);
      return holderPercentage >= this.rules.minHold!;
    });

    // Count total tx length
    const limitDividerByRewards = this.rewardDivider();
    const limit = 24 / limitDividerByRewards;
    let distributed = 0;
    let preparedHolders = [
      ...filteredHolders.filter(
        (obj, index, self) =>
          index ===
          self.findIndex(
            (o) =>
              o.owner.toLowerCase().trim() === obj.owner.toLowerCase().trim()
          )
      ),
    ];
    const listAddressHolders = listWithdrawAbleHolders.flatMap(
      (h) => new PublicKey(h.address)
    );

    // Simulating SOL get total from withdraw
    const totalWithdrawAble = listWithdrawAbleHolders.reduce(
      (acc, curr) => (acc += curr.withheld_amount),
      0 as number
    );
    let estimateGetSolFromWd = this.calculateWithdrawFeeToSolLamports(
      totalWithdrawAble,
      this.poolInfo!
    );
    let estimatedSolOutFromWd = this.calculateSOLNeededToPerformWithdraw(
      listAddressHolders.length
    );
    const withdrawPercent = this.getHolderPercentage(totalWithdrawAble);
    this.logger.log({
      level: "debug",
      label: "estimate",
      message: `From WD -- IN: ${(
        estimateGetSolFromWd / LAMPORTS_PER_SOL
      ).toFixed(10)} SOL -- OUT: ${(
        estimatedSolOutFromWd / LAMPORTS_PER_SOL
      ).toFixed(5)} SOL from ${
        listAddressHolders.length
      } from ${withdrawPercent}% tokens`,
    });

    // Calculate estimate sol for distribute
    let estimateSOLOutWhileDistribute =
      this.calculateSOLNeededToPerformDistribute(
        preparedHolders,
        estimateGetSolFromWd
      );

    this.logger.log({
      level: "debug",
      label: "estimate",
      message: `Estimated SOL used for distribute ${
        estimateSOLOutWhileDistribute / LAMPORTS_PER_SOL
      } SOL.`,
    });
    if (
      estimateGetSolFromWd > estimatedSolOutFromWd &&
      estimateGetSolFromWd > this.options.minGetSol! * LAMPORTS_PER_SOL &&
      estimateGetSolFromWd > estimateSOLOutWhileDistribute
    ) {
      //! if (true) to force
      // if (true) {
      // Withdrawing process
      // let initialTok = await this.connection.getTokenAccountBalance(
      //   this._getAta()
      // );
      await sleep(2000);
      let initialBal = await this.connection.getBalance(this.signer.publicKey);
      await sleep(2000);
      let wdAmount = await this.withdrawFee(
        this.mint,
        this.signer,
        listAddressHolders
      );

      // await sleep(3000);
      // const afterTol = await this.connection.getTokenAccountBalance(
      //   this._getAta()
      // );

      let wdSol = this.calculateWithdrawFeeToSolLamports(
        wdAmount,
        this.poolInfo!
      );
      await sleep(2000);

      //! Force
      // wdSol = 0.3 * LAMPORTS_PER_SOL;
      this.logger.log({
        level: "verbose",
        label: "runner",
        message: `Withdrawed Fee ${
          wdAmount / 10 ** this.mint.decimals
        } Tokens. Estimate ${(wdSol / LAMPORTS_PER_SOL).toFixed(5)} SOL`,
      });
      if (wdSol > estimateGetSolFromWd) {
        if (this.options.wdAndSwap != true) {
          await sleep(3000);
          await this.swapFee((wdAmount * this.options.swapFeePercent!) / 100);
        }
        await sleep(3000);

        let afterBal = await this.connection.getBalance(this.signer.publicKey);

        if (afterBal - initialBal > 0) {
          wdSol = afterBal - initialBal;

          this.logger.log({
            level: "info",
            label: "runner",
            message: `Withdrawed Fee ${
              wdAmount / 10 ** this.mint.decimals
            } Tokens. Got ${(wdSol / LAMPORTS_PER_SOL).toFixed(5)} SOL`,
          });
        }
        await sleep(3000);
        // Swap reward
        await this._swapReward((wdSol * this.options.swapRewardPercent!) / 100);
        // Get reward snapshot
        await sleep(3000);
        await this._getSnapshotReward();

        await sleep(5000);

        // Distributing
        this.logger.log({
          level: "verbose",
          label: "runner",
          message: `${filteredHolders.length} accounts passed (held ${this.rules.minHold}%) of ${listHolders.length}`,
        });
        let i = 0;
        while (preparedHolders.length > 0) {
          const totalQueued = Math.ceil(preparedHolders.length / limit);
          const holders = preparedHolders.splice(0, limit);

          if (holders.length > 0) {
            const remaining = await this.distribute(
              this.signer,
              this.mint,
              holders,
              i++,
              totalQueued,
              wdSol
            );
            if (remaining.length > 0) preparedHolders.push(...remaining);
            distributed += holders.length;
            await sleep(2000);
          }
        }
        this.logger.log({
          level: "info",
          label: "runner",
          message: `Distribution complete`,
        });
      } else {
        // Skip withdraw too expensive
        this.logger.log({
          level: "warn",
          label: "runner",
          message: `Withdraw actual ${wdSol / LAMPORTS_PER_SOL} SOL. Expected ${
            estimateGetSolFromWd / LAMPORTS_PER_SOL
          } SOL. Skipping distribution...`,
        });
      }
    } else {
      if (estimateGetSolFromWd <= this.options.minGetSol! * LAMPORTS_PER_SOL) {
        this.logger.log({
          level: "warn",
          label: "withdraw",
          message: `Estimated get ${(
            estimateGetSolFromWd / LAMPORTS_PER_SOL
          ).toFixed(5)} SOL less than minimum (${
            this.options.minGetSol
          } SOL). Skipping withdraw...`,
        });
      } else if (estimateGetSolFromWd > estimateSOLOutWhileDistribute) {
        // Skip distribute too expensive
        this.logger.log({
          level: "warn",
          label: "runner",
          message: `Estimated WD ${
            estimateGetSolFromWd / LAMPORTS_PER_SOL
          } SOL. Estimated distribute OUT ${
            estimateSOLOutWhileDistribute / LAMPORTS_PER_SOL
          } SOL. Skipping withdraw...`,
        });
      } else {
        // SOL IN and OUT from estimated
        this.logger.log({
          level: "warn",
          label: "runner",
          message: `Est IN (${(estimateGetSolFromWd / LAMPORTS_PER_SOL).toFixed(
            5
          )} SOL) -- Est Distribute Used (${(
            estimatedSolOutFromWd / LAMPORTS_PER_SOL
          ).toFixed(5)} SOL). Skipping withdraw...`,
        });
      }
    }
    await sleep(2000);
    const endBalance = await this.connection.getBalance(this.signer.publicKey);
    balanceLogger.log({
      level: "info",
      label: "signer",
      message: `Signer balance before ${(
        startBalance / LAMPORTS_PER_SOL
      ).toFixed(7)} SOL. Balance after ${(
        endBalance / LAMPORTS_PER_SOL
      ).toFixed(7)} SOL`,
    });
    this.logger.log({
      level: "verbose",
      label: "runner",
      message: `Waiting for next distribution time in ${this.options.distributionIntervalMinutes} minutes`,
    });
    await sleep(this.options.distributionIntervalMinutes! * 60 * 1000);
    return await this.run();
  }
}

export default RewardDistributionRunner;
