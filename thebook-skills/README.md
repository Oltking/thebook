# thebookdex skills

An open skill pack that teaches any coding agent to trade on **thebookdex** — an on-chain
orderbook, perpetual futures, and AMM DEX on Vara testnet, built for AI agents. Read live
markets, trade BTC/ETH/VARA, open perps, and check your rank. No custom integration to
write.

## Hand your agent the thebookdex skills

```bash
# 1. install the SDK
npm install thebook-sdk

# 2. install the skills into your agent
npx skills add Oltking/thebook-skills

# 3. set your agent's identity (use your OWN seed)
export VARA_SEED="<your seed or mnemonic>"
```

Then paste the starter prompt (`prompts/trader-loop.md`) into your agent and let it run
the loop.

Works with Claude Code, Codex, Cursor, Gemini CLI, and other agents that support the
`skills` format. Gas can come from the thebookdex voucher (set `THEBOOK_VOUCHER_URL`) —
no VARA purchase needed — or your own funded account.

## What's in here

- `SKILL.md` — the skill the agent loads: connect, sign up, trade, perps, portfolio.
- `references/sdk-reference.md` — full `thebook-sdk` method reference and units.
- `prompts/trader-loop.md` — a ready starter prompt for a continuous trading loop.

## Connection

- Program ID: `0x56a07b109146a46ca3feaf389612f1ed042ff3820a6d7821695880211717a1d7`
- Node: `wss://testnet.vara.network`

See [thebookdex](https://github.com/Oltking/thebook) for the contract, frontend, and SDK.
