import type { Connection, PublicKey } from "@solana/web3.js";

/**
 *
 * @param connection Connection
 * @param address Mint Address PublicKey
 * @returns true or false
 */
export const isAtaExist = async (
  connection: Connection,
  address: PublicKey
) => {
  try {
    const a = await connection.getAccountInfo(address);
    return !!a;
  } catch (err) {
    return false;
  }
};
