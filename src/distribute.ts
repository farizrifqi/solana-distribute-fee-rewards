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
  getOrCreateAssociatedTokenAccount,
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
import swap from "./swap";
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
  swapFeePercent: 75,
  minGetSol: 0.003,
  swapRewardPercent: 60,
  minWithdrawPercent: 0.1,
};
const mintLiquidityReserveCutPercent = 90;
const balanceLogger = new Logger("balance");

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
        level: "warn",
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

    //! Validate rewards mint
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

    const feeAuthorityBalance = await this.connection.getBalance(
      this.signer.publicKey
    );
    if (!feeAuthorityBalance) {
      this.logger.log({
        level: "warn",
        label: "validate",
        message: "Account info not found",
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
          message: "Fee receiver not same",
        });
        process.exit();
      }
      this.logger.log({
        level: "verbose",
        label: "account",
        message: `Fee authority balance: ${
          feeAuthorityBalance / LAMPORTS_PER_SOL
        } SOL`,
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
    //! Validate rewards mint poolInfo
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

    //!Validate ata rewards and mint
    await getOrCreateAssociatedTokenAccount(
      this.connection,
      this.signer,
      this.mint.address,
      this.signer.publicKey,
      false,
      undefined,
      undefined,
      this.mint.programId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    await sleep(1000);
    for await (const reward of this.rewards.filter(
      (r) => r.publicKey.toString() != NATIVE_MINT.toString()
    )) {
      try {
        await getOrCreateAssociatedTokenAccount(
          this.connection,
          this.signer,
          reward.publicKey,
          this.signer.publicKey,
          false,
          undefined,
          undefined,
          reward.programId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        );
      } catch (err) {
        this.logger.log({
          level: "error",
          label: "validate",
          message: `Something wrong on get or Create Ata for reward token ${reward.name}`,
        });
        process.exit();
      }
      await sleep(1000);
    }
    this.validated = true;
    this.logger.log({
      level: "info",
      label: "validate",
      message: `Validation passed.`,
    });

    await sleep(2000);
  }

  private async withdrawFee(
    mint: Mint,
    receiver: Keypair,
    tokenAccounts: PublicKey[]
  ) {
    let totalWithdrawed = 0;
    const limit = this.options.wdAndSwap == true ? 10 : 20;
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
      await sleep(1000);
    }

    const denom = 10 ** mint.decimals;
    this.logger.log({
      level: "verbose",
      label: "withdraw",
      message: `Withdraw done, total withdrawed ${totalWithdrawed / denom} `,
    });

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
    this.logger.log({
      level: "verbose",
      label: "withdraw",
      message: `Withdrawing fee from ${tokenAccounts.length} accounts`,
    });
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
      const afterSimulatePercent =
        (Number(afterSimulate.amount) * 100) / Number(this.mint.supply);
      if (
        initialBalance > -1 &&
        initialBalance == Number(afterSimulate.amount)
      ) {
        this.logger.log({
          level: "warn",
          label: "withdraw",
          message: `Seems no balance changes, skipping...`,
        });
        return { withdrawAmount: 0, remaining };
      }
      if (afterSimulatePercent <= this.options.minWithdrawPercent!) {
        this.logger.log({
          level: "warn",
          label: "withdraw",
          message: `Withdrawed amount only ${afterSimulatePercent.toFixed(
            3
          )}% which less than ${
            this.options.minWithdrawPercent
          }% of max supply.`,
        });
        return { withdrawAmount: 0, remaining };
      }
      const withdrawAmount = Number(afterSimulate.amount) - initialBalance;
      await sleep(500);
      const sigwd = await this.connection.sendTransaction(versionedTx);

      if (this.options.wdAndSwap != true) {
        this.logger.log({
          level: "info",
          label: "withdraw",
          message: `Gain +${
            withdrawAmount / 10 ** mint.decimals
          } (${afterSimulatePercent}%). tokens. at => ${sigwd}`,
        });
        return { remaining, withdrawAmount };
      }

      //! If withdraw & swap in one tx

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

      await sleep(5000);

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
            this.mint.programId,
            ASSOCIATED_TOKEN_PROGRAM_ID
          );
          const recipient = new PublicKey(holder.owner);
          if (
            reward.publicKey.toString().trim() == NATIVE_MINT.toString().trim()
          ) {
            const amount = this.calculateAmount(
              Number(this.poolInfo?.rpcData.baseReserve),
              holderPercentage,
              reward.percent
            );

            this.logger.log({
              level: "silly",
              label: "distribute",
              message: `Distributed ${
                amount / LAMPORTS_PER_SOL
              } SOL to holder with ${holderPercentage.toFixed(3)}%`,
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
            const ataRecipient = getAssociatedTokenAddressSync(
              r,
              recipient,
              false,
              reward.programId,
              ASSOCIATED_TOKEN_PROGRAM_ID
            );
            const ataExists = await isAtaExist(this.connection, ataRecipient);
            if (balanceReward && (ataExists || this.rules.ataExist == false)) {
              const amount = this.calculateAmount(
                Number(balanceReward),
                holderPercentage,
                reward.percent
              );

              if (!ataExists) {
                this.logger.log({
                  level: "silly",
                  label: "distribute",
                  message: `Creating ATA token ${reward.name} for ${ataRecipient
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
              }
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
                message: `Distributed ${amount / 10 ** 9} token ${
                  reward.name
                } to ${ataRecipient
                  .toBase58()
                  .split("")
                  .slice(0, 5)
                  .join("")} with ${holderPercentage.toFixed(3)}%`,
              });
            } else {
              if (!ataExists && this.rules.ataExist == false) {
                this.logger.log({
                  level: "warn",
                  label: "distribute",
                  message: `ATA recipient not exists. Skipped.`,
                });
              } else {
                this.logger.log({
                  level: "warn",
                  label: "distribute",
                  message: `No snapshot for reward ${reward.publicKey
                    .toString()
                    .toLowerCase()
                    .trim()
                    .split("")
                    .slice(-6)
                    .join("")}`,
                });
              }
            }
          }
        } catch (err) {}
        await sleep(50);
      }
      await sleep(50);
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
        remaining
      );
    }
    const versionedTx = new VersionedTransaction(tx);
    versionedTx.sign([this.signer]);
    try {
      const serializedVTx = versionedTx.serialize();
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
          message: `Distributed to ${holders.length} accounts. sig: ...${sig
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
      console.error({ simulateTx });
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
  }

  private async _swapReward(patokanAmountSol: number) {
    const swapAbleRewards = this.rewards.filter(
      (r) => r.publicKey.toString() != NATIVE_MINT.toString()
    );
    if (swapAbleRewards.length == 0) {
      return;
    }
    this.logger.log({
      level: "info",
      label: "reward",
      message: `Swapping to reward ${patokanAmountSol}`,
    });
    for await (const reward of swapAbleRewards) {
      const amountToSwap = (patokanAmountSol * reward.percent) / 100;
      if (amountToSwap >= 0) {
        try {
          const swapTx = await swap(
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
          const sign = await this.connection.sendTransaction(versionedTx);
          this.logger.log({
            level: "verbose",
            label: "swap-reward",
            message: `Success swap reward ${reward.publicKey
              .toString()
              .split("")
              .slice(-8)
              .join("")} of ${reward.percent}% on => ${sign
              .toString()
              .split("")
              .slice(-8)
              .join("")}}`,
          });
        } catch (err) {
          console.log({ err });
          this.logger.log({
            level: "warn",
            label: "swap-reward",
            message: `Failed tx swapping reward. Skipping...`,
          });
        }
      } else {
        this.logger.log({
          level: "warn",
          label: "swap-reward",
          message: `Swapping reward ${amountToSwap} tokens. Skipping...`,
        });
      }
    }
    await sleep(3000);
  }

  private async swapFee(amount: number) {
    if (amount == 0) {
      this.logger.log({
        level: "warn",
        label: "fee",
        message: `Swapping token fee skipped.`,
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

    const tx = await this.connection.sendTransaction(versionedTx);
    this.logger.log({
      level: "verbose",
      label: "fee",
      message: `Token fee ${amount / 10 ** 9} swapped to SOL`,
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
    const gap = this.rewards.length * 1.5;
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
    const feeConfig = getTransferFeeConfig(this.mint);
    const feePercentBasis =
      feeConfig?.newerTransferFee.transferFeeBasisPoints ?? 100;
    const feePercent = feePercentBasis / 100 / 100;

    //* Mint fee percentage
    amount = amount * feePercent;

    //* Hold percentage
    amount = (amount * holderPercentage) / 100;

    //* Reward percentage
    amount = (amount * rewardPercent) / 100;

    //* Pool percentage
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

    const listHolders = await getHolders(
      this.mint.address.toBase58(),
      this.heliusRPCURL,
      this.logger
    );

    const listAddressHolders = listHolders.flatMap(
      (h) => new PublicKey(h.address)
    );

    const initialSol = await this.connection.getBalance(this.signer.publicKey);
    let wdAmount = await this.withdrawFee(
      this.mint,
      this.signer,
      listAddressHolders
    );
    const percentageWd = (wdAmount * 100) / Number(this.mint.supply);
    if (wdAmount != 0 && percentageWd >= 0.0005) {
      if (this.options.wdAndSwap != true) {
        const totalBalance = await this.connection.getTokenAccountBalance(
          this._getAta()
        );
        await this.swapFee(
          (Number(totalBalance.value.amount) * this.options.swapFeePercent!) /
            100
        );
      }
      await sleep(3000);
      const afterWDSol = await this.connection.getBalance(
        this.signer.publicKey
      );
      await sleep(3000);

      const filteredHolders = listHolders.filter((h) => {
        const holderPercentage = this.getHolderPercentage(h.amount);

        return (
          holderPercentage >= this.rules.minHold! && holderPercentage <= 90
        );
      });
      let gapSol = afterWDSol - initialSol;
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
      gapSol = gapSol < 0 ? gapSol * -1 : gapSol;
      const estimatedShouldMinimum = Math.ceil(preparedHolders.length / limit);
      if (
        gapSol >=
        (this.options.minGetSol! * estimatedShouldMinimum) / LAMPORTS_PER_SOL
      ) {
        this.logger.log({
          level: "verbose",
          label: "runner",
          message: `Got ${gapSol / LAMPORTS_PER_SOL} after Withdrawing`,
        });
        await this._swapReward(
          (gapSol * this.options.swapRewardPercent!) / 100
        );

        await this._getSnapshotReward();

        this.logger.log({
          level: "verbose",
          label: "runner",
          message: `${filteredHolders.length} accounts passed (held ${this.rules.minHold}%) of ${listHolders.length}`,
        });
        this.logger.log({
          level: "verbose",
          label: "runner",
          message: `Runner transfer, to ${filteredHolders.length} accounts`,
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
              totalQueued
            );
            if (remaining.length > 0) preparedHolders.push(...remaining);
            distributed += holders.length;
            await sleep(3000);
          } else {
            console.log("aw", holders.length, preparedHolders.length);
          }
        }

        this.logger.log({
          level: "info",
          label: "runner",
          message: `Distribution complete`,
        });
      } else {
        this.logger.log({
          level: "warn",
          label: "runner",
          message: `Got less than ${
            (this.options.minGetSol! * estimatedShouldMinimum) /
            LAMPORTS_PER_SOL
          } SOL from withdraw. Skipping distribution...`,
        });
      }
    } else {
      if (wdAmount == 0) {
        this.logger.log({
          level: "info",
          label: "runner",
          message: `No balance change while withdraw. Distribution skipped. `,
        });
      }
      if (percentageWd >= 0.0005) {
        this.logger.log({
          level: "info",
          label: "runner",
          message: `Withdraw amount too low. Distribution skipped. `,
        });
      }
    }
    await sleep(1000);
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
      level: "silly",
      label: "runner",
      message: `Waiting for next distribution time in ${this.options.distributionIntervalMinutes} minutes`,
    });
    this._resetSnapshotReward();
    await sleep(this.options.distributionIntervalMinutes! * 60 * 1000);
    return await this.run();
  }
}

export default RewardDistributionRunner;
