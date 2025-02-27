# Solana Token Fee Rewards Distribution

This repository provides a program to manage the distribution of token rewards by withdrawing transfer fees from all holders of a deployed mint token on Solana. It integrates with Raydium for swapping fees into Solana (SOL) and distributing the rewards. The program is designed for maximum configurability, supporting multiple reward tokens, adjustable swap fees, and custom distribution intervals.

## Key Features

1. **Fee Withdrawal**: Withdraws the transfer fees from all holders of a specified mint token.
2. **Fee Swap**: Swaps a portion of the withdrawn fee (in the mint token itself) into SOL using Raydium. This prevents 100% token swap, maintaining token price stability.
3. **Reward Distribution**: Distributes SOL and/or other tokens (such as USDC, USDT, or any mint token) as rewards to all holders based on their percentage of ownership.
4. **Configurable Rewards**: Supports distributing multiple rewards with configurable percentages for each.
5. **Customizable Rules**: Includes rules for minimum token holdings to receive rewards and options for creating Associated Token Accounts (ATA) for recipients.

## Reward Distribution Flow

1. Withdraw Transfer Fees: The program withdraws transfer fees from all holders of the deployed mint token.
2. Swap to SOL: A percentage of the withdrawn fee is swapped into SOL on Raydium (configured via swapFeePercent).
3. Reward Swapping: The program swaps a percentage of the SOL into the reward tokens (e.g., USDC, TokenA, TokenB, etc.), based on the reward percentages configured.
4. Distribute Rewards: The SOL and swapped tokens are distributed to the holders based on their holding percentage, adhering to the configured minHold rule.

```scss
┌──────────────────────────────────────┐
│                                      │
│   1. Withdraw Transfer Fees          │
│     (from all holders of mint token) │
│                                      │
└──────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────┐
│                                      │
│   2. Swap Fee to SOL (Raydium)       │
│      (X% of the fee swapped to SOL)  │
│                                      │
└──────────────────────────────────────┘
              │
              ▼
┌────────────────────────────────────────────────────────┐
│                                                        │
│   3. Swap and Distribute Rewards                       │
│      (Based on configured rewards, swap and distribute │
│       the fee in SOL and/or tokens)                    │
│                                                        │
└────────────────────────────────────────────────────────┘
```

## Considerations

- The total reward percentage must not exceed 100%.
- You can configure the rules to distribute only to holders with a minimum holding percentage (minHold).
- Be sure to set the Helius API key, as it's necessary for fetching token holders.
- Ensure that the Raydium liquidity pool for the token swaps is available and active.
