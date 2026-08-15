# Mainnet addresses (v1 spot)

Confirmed **Vara-side** program IDs for the curated spot markets. All are 32-byte Vara
program IDs (`H256`) — the contract escrows tokens by messaging these programs, so the
Ethereum-side bridge addresses are NOT used here.

## Tokens (Vara VFT programs)

| Symbol | Vara program ID | Decimals | Source |
|---|---|---|---|
| wVARA | `0x29c42c668012b1ce20720e4615229215023281ef4676fdc77bf047d7fbcb9d17` | 12 | RivrDEX contracts doc |
| wUSDT | `0x4255ff4a87a4c13dc39f74ace8c4948bbef2f75fb639d66639a1cfcc99e6243e` | 6 | RivrDEX contracts doc |
| wUSDC | `0xd1de816d7dce6439504552686ab333e5b7302b1549763656b30af1f8a5871b6a` | 6 (⚠ confirm) | user-provided |

> **wVARA on Ethereum** (`0xb67010f2246814e5c39593ac23a925d9e9d7e5ad`) is the 20-byte
> bridge counterpart — kept here for reference only, never passed to the contract.
>
> ⚠ **wUSDC decimals unconfirmed.** Assumed 6 (standard USDC); verify against the token's
> `VftMetadata/Decimals` before listing — a wrong `quote_dec` corrupts all price math on
> that pair.

## First markets to list (admin call, post-deploy)

`Spot/ListPair(base, quote, base_dec, quote_dec)` — admin/multisig only:

| Market | base (wVARA) | quote | base_dec | quote_dec |
|---|---|---|---|---|
| wVARA/wUSDT | `0x29c42c…9d17` | `0x4255ff…6243e` | 12 | 6 |
| wVARA/wUSDC | `0x29c42c…9d17` | `0xd1de81…871b6a` | 12 | 6 |

## Still needed

- **DEX program ID** — does not exist until the new spot contract is deployed (testnet
  dress rehearsal first, then mainnet). Once deployed it feeds `#61` (frontend/SDK/skill
  config) and every hardcoded program-id reference. The token addresses above are
  independent of it.
