# Terms of use

**Draft — not reviewed by counsel.** The audit's M-13 finding was that no terms, risk
disclosure or jurisdiction statement existed at all. This closes that gap so the
project is not operating with nothing; it is a starting point to take to a lawyer,
not a substitute for one. Anything involving leveraged derivatives especially needs
professional review before it is relied on.

Last updated: 28 August 2026.

---

## 1. What thebook is

thebook is open-source software: a set of smart contracts deployed on the Vara
network, and an interface for interacting with them. It is published under the MIT
licence (see [LICENSE](../LICENSE)).

It is **not** a regulated exchange, broker-dealer, custodian, or financial
institution. No entity holds your assets, executes trades on your behalf, or acts as
your intermediary. The contracts execute autonomously; the interface is a convenience
for calling them.

## 2. Non-custodial by design

You retain control of your keys and your tokens at all times. Assets move only when
you sign a transaction authorising it. Nobody — including the operators of this
software — can move, freeze, seize, or recover your funds.

This means there is no recovery path for a lost key, a mistaken transaction, an
address typed wrong, or a trade you regret.

## 3. No advice, no guarantees

Nothing in this software, its interface, its documentation, or any output it
generates is investment, financial, legal, or tax advice. Any price data, chart,
estimate, or automatically generated commentary is informational and may be wrong,
delayed, or unavailable.

The software is provided **"as is", without warranty of any kind**, express or
implied, including merchantability, fitness for a particular purpose, and
non-infringement.

## 4. Risk

You must read the [risk disclosure](risk-disclosure.md) before trading. In summary:
the contracts have not had an independent professional audit; the order books are
thin; leveraged positions can lose their entire margin; the perpetuals reserve can be
insufficient to pay winning positions in full; settlement depends on a single price
keeper; and administrative control is currently a single key rather than a multisig.

**Do not commit funds you are not prepared to lose entirely.**

## 5. Eligibility

You may use this software only if you are legally permitted to do so where you are.
Leveraged derivatives are restricted or prohibited for retail participants in many
jurisdictions. Determining your own eligibility is your responsibility, not ours.

Do not use this software if you are subject to sanctions, or to conduct or facilitate
any unlawful activity, including money laundering, sanctions evasion, or market
manipulation.

## 6. Automated and agent use

thebook publishes an SDK and an MCP tool server so autonomous agents can trade
directly. If you run one, you are responsible for everything it does with your key.

The tool server enforces per-trade and daily spend limits by default. **Those limits
are a safety net, not a security boundary** — anyone holding the seed can bypass them
by calling the contract directly. Fund an agent wallet only with what that agent may
lose, and keep its key separate from anything else.

## 7. Availability

There is no uptime commitment. The interface may be taken offline, and the contracts
may be paused, at any time and without notice. Pausing never blocks cancelling an
order or withdrawing a balance; that is a deliberate property of the contract.

Contracts may be superseded by new deployments. Where that happens, we will say so
and give holders a path to withdraw.

## 8. Limitation of liability

To the maximum extent permitted by law, the authors and contributors are not liable
for any loss arising from use of this software, including loss of funds, loss of
profits, loss of data, or losses from smart-contract defects, network failures,
oracle failures, key compromise, or third-party bridge failures.

## 9. Changes

These terms may change. Material changes will be noted in the repository history,
which is public. Continued use after a change means acceptance of it.

## 10. Contact

Issues and disclosures: <https://github.com/Oltking/thebook/issues>

For a suspected security vulnerability, please report it privately rather than in a
public issue.
