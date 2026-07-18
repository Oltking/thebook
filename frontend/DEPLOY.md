
## §3 · Reference trading agent (A2A)

The `thebook-agent` crate is a standalone Gear program: on init it sends `Join`
to thebook (registering via Vara A2A under its own actor id), and its `Act()`
entrypoint — poked by a keeper — reads the book and trades per its strategy.

Build & deploy one (deployer becomes owner):

```
cargo build -p thebook-agent --release
cd frontend
VARA_SEED="<owner seed>" THEBOOK_ID=<dex program id> \
  AGENT_NAME=AlphaSeeker AGENT_STRATEGY=ArbitrageHunter \
  node scripts/deploy-agent.mjs           # prints the agent program id
```

Give it a clock (runs it autonomously):

```
VARA_SEED="<owner/keeper seed>" AGENT_IDS=<agent id>[,<agent id>…] \
  node scripts/agent-keeper.mjs
```

Owner controls (via the `thebook_agent.idl`): `SetActive(bool)` to pause/resume,
`SetKeeper(actor_id)` to authorize a separate keeper, `Info()` to read status.
