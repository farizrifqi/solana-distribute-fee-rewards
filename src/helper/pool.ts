import {
  CREATE_CPMM_POOL_PROGRAM,
  DEVNET_PROGRAM_ID,
  getCpmmPdaAmmConfigId,
  getCpmmPdaPoolId,
  type ApiV3PoolInfoStandardItemCpmm,
  type CpmmKeys,
  type CpmmRpcData,
  type Raydium,
} from "@raydium-io/raydium-sdk-v2";
import { PublicKey } from "@solana/web3.js";
import { MAINNET } from "../../env";

type TokenInfo = {
  mint: string;
  amount: number;
};
export type PoolInfo = {
  poolInfo: ApiV3PoolInfoStandardItemCpmm;
  rpcData: CpmmRpcData;
  poolKeys: CpmmKeys;
  poolId: PublicKey;
  poolPrice: number;
  tokenAInfo: TokenInfo;
  tokenBInfo: TokenInfo;
  exchangeRate: number;
};
type GetPoolInfoParams = {
  raydium: Raydium;
  tokenA: PublicKey;
  tokenB: PublicKey;
};
/**
 *
 * Will exit instead if fail to get PoolInfo.
 *
 * @param raydium - Raydium
 * @param tokenA - mintA
 * @param tokenB - mintB
 * @returns PoolInfo
 */
export const getPoolInfopantatOri = async (
  params: GetPoolInfoParams
): Promise<null | PoolInfo> => {
  try {
    const { raydium, tokenA, tokenB } = params;
    const cpmmConfigs = await raydium.api.getCpmmConfigs();
    if (!MAINNET) {
      cpmmConfigs.forEach((config) => {
        config.id = getCpmmPdaAmmConfigId(
          DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
          config.index
        ).publicKey.toBase58();
      });
    }
    let res = getCpmmPdaPoolId(
      MAINNET
        ? CREATE_CPMM_POOL_PROGRAM
        : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
      new PublicKey(cpmmConfigs[0].id),
      tokenA,
      tokenB
    );
    let poolId = res.publicKey.toBase58();
    let poolInfos = null;

    try {
      poolInfos = await raydium.cpmm.getRpcPoolInfos([poolId]);
    } catch (error) {}

    if (poolInfos == null) {
      res = getCpmmPdaPoolId(
        MAINNET
          ? CREATE_CPMM_POOL_PROGRAM
          : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
        new PublicKey(cpmmConfigs[0].id),
        tokenB,
        tokenA
      );
      poolId = res.publicKey.toBase58();
      try {
        poolInfos = await raydium.cpmm.getRpcPoolInfos([poolId]);
      } catch (error) {}
    }
    if (poolInfos == null) {
      console.error("Error fetching CPMMPoolInfo");
      return null;
    }

    let poolInfo = poolInfos[poolId];
    let tokenAInfo, tokenBInfo, exchangeRate;
    if (tokenA.toBase58() == poolInfo.mintA.toBase58()) {
      tokenAInfo = {
        mint: tokenA.toBase58(),
        amount:
          Number(poolInfo.vaultAAmount.toString()) /
          10 ** poolInfo.mintDecimalA,
      };
      tokenBInfo = {
        mint: tokenB.toBase58(),
        amount:
          Number(poolInfo.vaultBAmount.toString()) /
          10 ** poolInfo.mintDecimalB,
      };
      exchangeRate = Number(poolInfo.poolPrice.toString());
    } else {
      tokenAInfo = {
        mint: tokenB.toBase58(),
        amount:
          Number(poolInfo.vaultBAmount.toString()) /
          10 ** poolInfo.mintDecimalB,
      };
      tokenBInfo = {
        mint: tokenA.toBase58(),
        amount:
          Number(poolInfo.vaultAAmount.toString()) /
          10 ** poolInfo.mintDecimalA,
      };
      exchangeRate = 1 / Number(poolInfo.poolPrice.toString());
    }

    let data = null;
    try {
      data = await raydium.cpmm.getPoolInfoFromRpc(poolId);
      if (!data) throw Error("Failed fetchPoolById");
    } catch (err) {
      console.log(`Failed fetchPoolById`);
      return null;
    }
    let preparedData = {
      poolInfo: data.poolInfo,
      rpcData: data.rpcData,
      poolKeys: data.poolKeys,
      poolId: new PublicKey(poolId),
      poolPrice: Number(poolInfo.poolPrice.toString()),
      tokenAInfo: tokenAInfo,
      tokenBInfo: tokenBInfo,
      exchangeRate: exchangeRate,
    };
    return preparedData;
  } catch (err) {
    console.log({ err });
    console.error("Error fetching CPMMPoolInfo");
    process.exit();
  }
};
export const getPoolInfo = async (
  params: GetPoolInfoParams
): Promise<null | PoolInfo> => {
  try {
    const { raydium, tokenA, tokenB } = params;
    const cpmmConfigs = await raydium.api.getCpmmConfigs();
    if (!MAINNET) {
      cpmmConfigs.forEach((config) => {
        config.id = getCpmmPdaAmmConfigId(
          DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
          config.index
        ).publicKey.toBase58();
      });
    }
    let res = getCpmmPdaPoolId(
      MAINNET
        ? CREATE_CPMM_POOL_PROGRAM
        : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
      new PublicKey(cpmmConfigs[0].id),
      tokenA,
      tokenB
    );
    let poolId = res.publicKey.toBase58();
    let poolInfos = null;

    try {
      poolInfos = await raydium.cpmm.getRpcPoolInfos([poolId]);
    } catch (error) {}

    if (poolInfos == null) {
      res = getCpmmPdaPoolId(
        MAINNET
          ? CREATE_CPMM_POOL_PROGRAM
          : DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM,
        new PublicKey(cpmmConfigs[0].id),
        tokenB,
        tokenA
      );
      poolId = res.publicKey.toBase58();
      try {
        poolInfos = await raydium.cpmm.getRpcPoolInfos([poolId]);
      } catch (error) {}
    }
    if (poolInfos == null) {
      try {
        const poolIdByMints = await raydium.api.fetchPoolByMints({
          mint1: tokenA,
          mint2: tokenB,
        });
        if (poolIdByMints && poolIdByMints?.data.length > 0) {
          poolId = poolIdByMints.data[0].id;
          poolInfos = await raydium.cpmm.getRpcPoolInfos([poolId]);
        }
      } catch (err) {}
    }
    if (poolInfos == null) {
      console.error("Error fetching CPMMPoolInfo");
      return null;
    }

    let poolInfo = poolInfos[poolId];
    let tokenAInfo, tokenBInfo, exchangeRate;
    if (tokenA.toBase58() == poolInfo.mintA.toBase58()) {
      tokenAInfo = {
        mint: tokenA.toBase58(),
        amount:
          Number(poolInfo.vaultAAmount.toString()) /
          10 ** poolInfo.mintDecimalA,
      };
      tokenBInfo = {
        mint: tokenB.toBase58(),
        amount:
          Number(poolInfo.vaultBAmount.toString()) /
          10 ** poolInfo.mintDecimalB,
      };
      exchangeRate = Number(poolInfo.poolPrice.toString());
    } else {
      tokenAInfo = {
        mint: tokenB.toBase58(),
        amount:
          Number(poolInfo.vaultBAmount.toString()) /
          10 ** poolInfo.mintDecimalB,
      };
      tokenBInfo = {
        mint: tokenA.toBase58(),
        amount:
          Number(poolInfo.vaultAAmount.toString()) /
          10 ** poolInfo.mintDecimalA,
      };
      exchangeRate = 1 / Number(poolInfo.poolPrice.toString());
    }

    let data = null;
    try {
      data = await raydium.cpmm.getPoolInfoFromRpc(poolId);
      if (!data) throw Error("Failed fetchPoolById");
    } catch (err) {
      console.log(`Failed fetchPoolById`);
      return null;
    }
    let preparedData = {
      poolInfo: data.poolInfo,
      rpcData: data.rpcData,
      poolKeys: data.poolKeys,
      poolId: new PublicKey(poolId),
      poolPrice: Number(poolInfo.poolPrice.toString()),
      tokenAInfo: tokenAInfo,
      tokenBInfo: tokenBInfo,
      exchangeRate: exchangeRate,
    };
    return preparedData;
  } catch (err) {
    console.log({ err });
    console.error("Error fetching CPMMPoolInfo");
    process.exit();
  }
};

export const getPoolInfoBiasa = async (
  params: GetPoolInfoParams
): Promise<null | PoolInfo> => {
  try {
    const { raydium, tokenA, tokenB } = params;
    const cpmmConfigs = await raydium.api.getCpmmConfigs();
    let res = getCpmmPdaPoolId(
      CREATE_CPMM_POOL_PROGRAM,
      new PublicKey(cpmmConfigs[0].id),
      tokenA,
      tokenB
    );
    let poolId = "3GvARzp3NgQLedRkESwNeWk7bwMFrxLVzCnqiaZEczZ8";

    let poolInfos = null;

    try {
      poolInfos = await raydium.cpmm.getRpcPoolInfos([poolId]);
    } catch (error) {}

    if (poolInfos == null) {
      res = getCpmmPdaPoolId(
        CREATE_CPMM_POOL_PROGRAM,
        new PublicKey(cpmmConfigs[0].id),
        tokenB,
        tokenA
      );
      poolId = res.publicKey.toBase58();
      try {
        poolInfos = await raydium.cpmm.getRpcPoolInfos([poolId]);
      } catch (error) {}
    }
    if (poolInfos == null) {
      console.error("Error fetching CPMMPoolInfo");
      return null;
    }

    let poolInfo = poolInfos[poolId];
    let tokenAInfo, tokenBInfo, exchangeRate;
    if (tokenA.toBase58() == poolInfo.mintA.toBase58()) {
      tokenAInfo = {
        mint: tokenA.toBase58(),
        amount:
          Number(poolInfo.vaultAAmount.toString()) /
          10 ** poolInfo.mintDecimalA,
      };
      tokenBInfo = {
        mint: tokenB.toBase58(),
        amount:
          Number(poolInfo.vaultBAmount.toString()) /
          10 ** poolInfo.mintDecimalB,
      };
      exchangeRate = Number(poolInfo.poolPrice.toString());
    } else {
      tokenAInfo = {
        mint: tokenB.toBase58(),
        amount:
          Number(poolInfo.vaultBAmount.toString()) /
          10 ** poolInfo.mintDecimalB,
      };
      tokenBInfo = {
        mint: tokenA.toBase58(),
        amount:
          Number(poolInfo.vaultAAmount.toString()) /
          10 ** poolInfo.mintDecimalA,
      };
      exchangeRate = 1 / Number(poolInfo.poolPrice.toString());
    }

    let data = null;
    try {
      data = await raydium.cpmm.getPoolInfoFromRpc(poolId);
      if (!data) throw Error("Failed fetchPoolById");
    } catch (err) {
      console.log(`Failed fetchPoolById`);
      return null;
    }
    let preparedData = {
      poolInfo: data.poolInfo,
      rpcData: data.rpcData,
      poolKeys: data.poolKeys,
      poolId: new PublicKey(poolId),
      poolPrice: Number(poolInfo.poolPrice.toString()),
      tokenAInfo: tokenAInfo,
      tokenBInfo: tokenBInfo,
      exchangeRate: exchangeRate,
    };
    return preparedData;
  } catch (err) {
    console.log({ err });
    console.error("Error fetching CPMMPoolInfo");
    process.exit();
  }
};
