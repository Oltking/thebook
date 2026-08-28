# thebook MCP server (skill pack)

Give any AI agent the ability to trade on **thebookdex**. This is a Model Context
Protocol server: it exposes the exchange as tools an agent can call directly, in
natural language, from Claude Desktop, Claude Code, Cursor, or any custom
MCP-compatible agent. No website, no hand-wiring.

The agent's account (`VARA_SEED`) is its identity, so every order it places is its
own. thebookdex v1 is a **non-custodial spot CLOB** over real bridged tokens on Vara
mainnet: the agent trades the actual wUSDT/wUSDC/wETH/wVARA in its wallet.

> **Mainnet, real funds.** The seed controls real tokens. Fund an agent wallet only
> with what that agent may lose, and keep its key separate from anything else. The
> spend limits below are on by default.
>
> **The contract has not had an independent professional audit**, and the deployed
> program is pending an audit-remediation redeploy. Read the
> [risk disclosure](https://github.com/Oltking/thebook/blob/master/docs/risk-disclosure.md)
> before pointing an agent at it.

## Tools

| Tool | What it does |
| --- | --- |
| `thebook_pairs` | List the curated markets (pair id, base/quote token ids, decimals). Call first. |
| `thebook_orderbook` | Live bids/asks for a market |
| `thebook_limits` | The spend limits in force and how much of today's budget is left |
| `thebook_approve` | Approve the exchange to escrow a token before trading it (quote for a buy, base for a sell) |
| `thebook_allowance` | This wallet's allowance to the exchange for a token, plus its balance |
| `thebook_place_limit` | Place a resting limit order |
| `thebook_market_buy` / `thebook_market_sell` | Immediate fills, with a required slippage bound |
| `thebook_cancel_order` / `thebook_my_orders` | Manage resting orders |
| `thebook_claim` / `thebook_withdraw` | Read and pull proceeds / cancelled escrow back to the wallet |

Amounts and prices are token **smallest-units** (sized by each token's decimals:
wVARA 12, wETH 18, wUSDT/wUSDC 6). A limit `price` is quote smallest-units per one
whole base.

## Spend limits

This is **mainnet with real funds**, and the contract has no on-chain per-session
spend cap yet, so the caps live in this server. Every value-moving tool is bounded:

| Variable | Default | What it does |
| --- | --- | --- |
| `THEBOOK_MAX_TRADE_USD` | `100` | Most any one order may commit. `0` disables all limits. |
| `THEBOOK_MAX_DAILY_USD` | `500` | Most all orders may commit in 24h |
| `THEBOOK_CONFIRM_USD` | `25` | Above this, a tool refuses until called again with `confirm: true` |

Every tool echoes the human-readable amount (`0.04 wETH (~$100.00)`) before acting,
and refuses tokens it cannot price. That matters because of the decimal spread:
wETH is 18 decimals, wVARA 12, the stablecoins 6, and all of them are passed as raw
smallest-unit integers — **one wrong exponent is a millionfold error.** A model that
reaches for the wrong one should hit a cap, not the chain.

These limits are a safety net, not a security boundary. Anyone holding the seed can
bypass them by calling the contract directly. **Fund an agent wallet only with what
that agent may lose.**

### Slippage bounds

`thebook_market_buy` and `thebook_market_sell` both require a bound (`minBaseOut` /
`minQuoteOut`): the worst fill the order will accept. If the book cannot meet it the
order reverts and the escrow is returned. thebook's books are thin — passing `0`
here means "accept any price", which on a thin book is how you get filled at one.

## Install

```bash
npm install -g @thebookdex/mcp     # once published
# or run straight from the repo:
cd mcp && npm install
```

## Configure your agent

Add it to your MCP client config with your account seed and the thebookdex program
id. For **Claude Desktop** (`claude_desktop_config.json`) or **Claude Code**
(`.mcp.json`):

```json
{
  "mcpServers": {
    "thebook": {
      "command": "npx",
      "args": ["-y", "@thebookdex/mcp"],
      "env": {
        "VARA_SEED": "your twelve word mainnet mnemonic",
        "THEBOOK_PROGRAM_ID": "0x7c5dbc8a85a8526c3a0c4fe98f0fb286782849c4d130ff28d6b7b30d157c2484",
        "NODE_ADDRESS": "wss://rpc.vara.network",
        "THEBOOK_VOUCHER_URL": "https://thebookdex.xyz/api/voucher",
        "THEBOOK_MAX_TRADE_USD": "100",
        "THEBOOK_MAX_DAILY_USD": "500",
        "THEBOOK_CONFIRM_USD": "25"
      }
    }
  }
}
```

`THEBOOK_VOUCHER_URL` is optional — set it to the app's `/api/voucher` and the
agent's gas is sponsor-paid, so it needs no VARA of its own.

Running from a local checkout instead of npm:

```json
{
  "mcpServers": {
    "thebook": {
      "command": "node",
      "args": ["/absolute/path/to/thebook/mcp/server.mjs"],
      "env": {
        "VARA_SEED": "…",
        "THEBOOK_PROGRAM_ID": "0x7c5dbc8a85a8526c3a0c4fe98f0fb286782849c4d130ff28d6b7b30d157c2484"
      }
    }
  }
}
```

Restart the client. The agent now has thebookdex tools. Try: *"List the markets on
thebook, show me the ETH/USDT order book, approve 100 wUSDT, then place a limit buy
for 0.01 ETH at 2500."*

## Getting funds

thebookdex is non-custodial: the agent trades the **real bridged tokens already in
its wallet**. There is no faucet and no starting balance.

1. Hold **wUSDT / wUSDC** to buy and **wETH / wVARA** to sell in the seed's account
   (address is `book.address`).
2. It needs a little VARA for gas — or set `THEBOOK_VOUCHER_URL` so gas is
   sponsor-paid and it needs none.
3. `thebook_approve` the amount the next order escrows, place it, then
   `thebook_withdraw` to pull proceeds back out. Approve per order rather than
   granting a standing allowance — an allowance is only as safe as the contract
   holding it.

## How it relates to the SDK

This server is a thin wrapper over [`thebook-sdk`](../sdk) (the engine that signs
and sends on-chain calls). Use the SDK when you're writing an agent's code
yourself; use this MCP server when you want an existing AI agent to operate
thebookdex on its own.
