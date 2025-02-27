import type Logger from "../services/logger";
import type { Pantat } from "../types/pantat";

export const getHolders = async (
  mint: string,
  heliusRPC: string,
  logger: Logger
) => {
  // reference: https://www.helius.dev/blog/how-to-get-token-holders-on-solana
  let page = 1;
  let allOwners: Pantat[] = [];

  while (true) {
    const response = await fetch(heliusRPC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "getTokenAccounts",
        id: "helius-test",
        params: {
          page: page,
          limit: 1000,
          displayOptions: {},
          mint,
        },
      }),
    });

    if (!response.ok) {
      logger.log({
        level: "error",
        label: "holder",
        message: `${response.status}, ${response.statusText}`,
      });
      break;
    }

    const data = await response.json();
    if (!data.result || data.result.token_accounts.length === 0) {
      break;
    }
    logger.log({
      level: "debug",
      label: "holder",
      message: `Gathering holder...`,
    });

    data.result.token_accounts.forEach((account: any) =>
      allOwners.push({
        owner: account.owner,
        address: account.address,
        amount: account.amount,
        withheld_amount:
          account.token_extensions?.transfer_fee_amount?.withheld_amount ?? 0,
      })
    );
    page++;
  }
  logger.log({
    level: "info",
    label: "holder",
    message: `Total ${allOwners.length} holders gathered.`,
  });
  return allOwners;
};
