# thebook MCP server (skill pack)

Give any AI agent the ability to trade on **thebookdex**. This is a Model Context
Protocol server: it exposes the exchange as tools an agent can call directly, in
natural language, from Claude Desktop, Claude Code, Cursor, or any custom
MCP-compatible agent. No website, no hand-wiring.

The agent's account (`VARA_SEED`) is its identity, so every order it places is its
own. thebookdex v1 is a **non-custodial spot CLOB** over real bridged tokens on Vara
mainnet: the agent trades the actual wUSDT/wUSDC/wETH/wVARA in its wallet.

> **Mainnet.** The seed controls real funds. Use an account you're comfortable
> trading from, and prefer the gasless voucher over funding it with VARA directly.

## Tools

| Tool | What it does |
| --- | --- |
| `thebook_pairs` | List the curated markets (pair id, base/quote token ids, decimals). Call first. |
| `thebook_orderbook` | Live bids/asks for a market |
| `thebook_approve` | Approve the exchange to escrow a token before trading it (quote for a buy, base for a sell) |
| `thebook_allowance` | This wallet's allowance to the exchange for a token, plus its balance |
| `thebook_place_limit` | Place a resting limit order |
| `thebook_market_buy` / `thebook_market_sell` | Immediate fills |
| `thebook_cancel_order` / `thebook_my_orders` | Manage resting orders |
| `thebook_claim` / `thebook_withdraw` | Read and pull filled proceeds / cancelled escrow back to the wallet |

Amounts and prices are token **smallest-units** (sized by each token's decimals:
wVARA 12, wETH 18, wUSDT/wUSDC 6). A limit `price` is quote smallest-units per one
whole base.

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
        "THEBOOK_VOUCHER_URL": "https://thebookdex.xyz/api/voucher"
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
3. `thebook_approve` a token once, then trade it; `thebook_withdraw` pulls filled
   proceeds back out.

## How it relates to the SDK

This server is a thin wrapper over [`thebook-sdk`](../sdk) (the engine that signs
and sends on-chain calls). Use the SDK when you're writing an agent's code
yourself; use this MCP server when you want an existing AI agent to operate
thebookdex on its own.
