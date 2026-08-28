# Risk disclosure

**This is not legal advice, and it is not investment advice.** It is a plain
description of how thebook can lose you money, written because the audit found the
interface offered leveraged perpetual futures with no risk statement of any kind
(finding M-13).

Read this before you trade. If any of it is unacceptable to you, do not use thebook.

---

## The contract is not independently audited

The review this document accompanies was a full-stack security assessment. It found
three exploitable critical defects, all of which have been fixed and covered by
regression tests. **It was not a professional third-party audit, and no such audit
has been completed.**

The project's own release checklist requires an independent audit before real funds.
That requirement is not yet met.

## You hold your own funds, and that cuts both ways

thebook is non-custodial. Nobody can move your tokens except you and the contract
you approve. There is also nobody who can reverse a mistake, restore a lost key,
recover a wrong address, or refund a bad trade. There is no support desk that can
undo an on-chain action.

Approvals are the one place you hand over spending authority. The interface approves
exactly what each order escrows, and nothing more. If you approve a larger amount by
other means, that amount is what is at risk.

## Spot trading

- **The books are thin.** thebook has no committed market makers. A market order can
  be filled at a price far from what you expected, or barely filled at all.
- **Always use the slippage bound.** Market orders require one. It is the difference
  between "I accept the market price" and "I accept any price". If the book cannot
  meet your bound, the order reverts and your tokens are returned.
- **Order history is not stored on chain.** Filled and cancelled orders are removed
  from contract state and exist only as events. If you need records, keep your own.

## Liquidity pools

Supplying liquidity is not a savings account. It is taking one side of every trade
that passes through the pool.

- **You earn 0.3% of every swap**, in proportion to your share of the pool. Fees are
  not paid to you separately; they stay in the pool, so what your shares redeem for
  grows. You realise them by withdrawing.
- **Impermanent loss is real and is the main risk.** When the price of the two tokens
  moves apart, arbitrage traders rebalance the pool by buying the one that rose. You
  end up holding more of the asset that fell and less of the one that rose, and can
  be worse off than if you had simply held both. Fees offset this. They do not always
  beat it, and on a volatile pair they often will not.
- **You cannot choose your price.** Deposits are minted at the pool's ratio at the
  moment they land, and the interface bounds that, but the pool decides the ratio.
- **Withdrawing is always available.** Removing liquidity is never blocked by a pause
  or by a pool being closed to new deposits. That is deliberate.
- **A pool with little liquidity moves a lot on small trades.** Early providers face
  the largest price impact and the largest impermanent loss.

## Perpetual futures — read this part twice

Perps are the highest-risk thing on this venue, by a wide margin.

- **Leverage multiplies losses, not just gains.** The venue launches capped at
  **5×**, where liquidation happens at roughly a 19% adverse move. That cap will be
  raised over time; the higher it goes, the closer liquidation sits to entry.
- **You can lose your entire margin.** That is the normal, expected outcome of a
  losing leveraged position, not an edge case.
- **The house is your counterparty.** Every position is against a house reserve, not
  another trader. The reserve carries the whole one-sided exposure of the market.
- **The reserve can run short, and payouts are capped by it.** If the reserve cannot
  cover what you earned, you are paid what it can cover. The contract refuses new
  positions below a 120% coverage floor and caps what the operator may withdraw
  against open liability, but neither guarantees you are paid in full.
  **Check reserve health before opening a position.**
- **Settlement depends on a single price keeper.** One account publishes the mark
  price that all PnL and liquidations settle against. Each update is bounded to a 10%
  move, and if the keeper stops, positions can be closed at entry (zero PnL) after
  roughly an hour — so you are never permanently trapped. But while it is running,
  that account's price is the price.
- **Funding is charged to the crowded side.** If you are on the majority side, you
  pay funding continuously to the reserve for as long as you hold.
- **Liquidation is permissionless.** Anyone can liquidate your position once it hits
  maintenance margin, and they are paid a fee for doing so.

## Technical risk

- Smart contracts can contain defects. This one did, and the ones that were found are
  fixed; the ones that were not found are, by definition, unknown.
- Vara network outages, RPC failures or congestion can prevent you from acting on a
  position at the moment you most want to.
- The interface can be paused. **Cancelling orders and withdrawing balances are never
  blocked by a pause** — that is a deliberate property of the contract — but placing
  new orders can be.
- Bridged tokens (wETH, wUSDT, wUSDC, wVARA) carry the risk of their own bridge and
  issuer, which is entirely outside thebook's control.

## Operational risk

The admin key can list and delist markets, set the price keeper, pause the venue, and
withdraw reserve surplus. **It is currently a single key, not a multisig.** Moving
admin to an N-of-M multisig is required by the project's own checklist and is not yet
done. Until it is, compromise of that one key is a serious event — see
[the incident runbook](incident-runbook.md).

## Eligibility and jurisdiction

thebook is unlicensed software published as open source. It is not a regulated
exchange, broker, or financial institution anywhere.

Leveraged derivatives are restricted or prohibited for retail participants in many
jurisdictions, including several where this page is readable. **Determining whether
you may lawfully use this software is your responsibility.** Do not use it where it
is not lawful for you to do so.

Nothing here is an offer, solicitation, or recommendation to trade anything.

## In one sentence

Unaudited software, thin books, a single admin key, a house-backed leverage product
where the reserve can run short, and liquidity pools that can lose money even when
they earn fees — **do not commit funds you are not prepared to lose entirely.**
