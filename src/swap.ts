import { PublicKey } from "@solana/web3.js";
import {
  CurveCalculator,
  Raydium,
  TxVersion,
  type ComputeBudgetConfig,
} from "@raydium-io/raydium-sdk-v2";

import { BN } from "bn.js";
import { getPoolInfo } from "./helper/pool";
import { sleep } from "./helper/async";

/**
 *
 * @param raydium Raydium
 * @param tokenA token IN
 * @param tokenB token OUT
 * @param amountIn Amount IN
 * @param slippage Slippage 0-1 (eg. 0.7 = 70%), default 0.5 (50%)
 * @param computeBudgetConfig
 * @returns Transaction (Legacy)
 */
const swap = async (
  raydium: Raydium,
  tokenA: PublicKey,
  tokenB: PublicKey,
  amountIn: number,
  slippage = 0.5,
  computeBudgetConfig?: ComputeBudgetConfig,
  retries = 0
) => {
  const poolData = await getPoolInfo({ raydium, tokenA, tokenB });
  if (!poolData) {
    if (retries >= 3) {
      console.error(`Unable to getPoolData`);
      process.exit();
    }
    await sleep(1000);
    return await swap(
      raydium,
      tokenA,
      tokenB,
      amountIn,
      slippage,
      computeBudgetConfig,
      retries + 1
    );
  }
  const baseIn = tokenA.toBase58() === poolData.poolInfo.mintA.address;
  let swapSourceAmount, swapDestinationAmount, mintA, mintB;
  if (baseIn) {
    mintA = poolData.poolInfo.mintA;
    mintB = poolData.poolInfo.mintB;
  } else {
    mintA = poolData.poolInfo.mintB;
    mintB = poolData.poolInfo.mintA;
  }
  if (mintA.address === poolData.poolInfo.mintA.address) {
    swapSourceAmount = poolData.rpcData.baseReserve;
    swapDestinationAmount = poolData.rpcData.quoteReserve;
  } else {
    swapSourceAmount = poolData.rpcData.quoteReserve;
    swapDestinationAmount = poolData.rpcData.baseReserve;
  }
  const swapResult = CurveCalculator.swap(
    new BN(amountIn),
    swapSourceAmount,
    swapDestinationAmount,
    poolData.rpcData.configInfo?.tradeFeeRate ?? new BN(0)
  );
  const { transaction } = await raydium.cpmm.swap({
    poolInfo: poolData.poolInfo,
    poolKeys: poolData.poolKeys,
    inputAmount: new BN(amountIn),
    swapResult,
    slippage,
    baseIn,
    txVersion: TxVersion.LEGACY,
    computeBudgetConfig,
  });

  return transaction;
};
export default swap;
