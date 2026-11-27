# Dreamcash MCP

Let your own AI agent work with your [Dreamcash](https://dreamcash.xyz)
account. Dreamcash is a trading app on Hyperliquid; this MCP server lets an
agent such as Claude Code, Grok Bot, Hermes, OpenClaw or Cursor read your
account and markets, and trade: **each trade approved by you in the Dreamcash
app, or, if you let it, on its own within limits you set.**

> Using a chat app that connects to remote MCP servers (Claude, ChatGPT,
> Grok, Gemini)? You don't need this package: add
> `https://api.dreamcash.xyz/mcp` as a custom connector instead, and enter
> the code from the Dreamcash app (Settings › Connected AI) when it asks. Each
> trade then waits for you; trading on its own needs this package.

## What your agent can do

- **Read**: balances, positions, open orders, trade and order history, PnL,
  funding and transfers, XP and rewards, vaults, and Hyperliquid's markets
  (perps, HIP-3 markets, spot, prediction markets) with prices and charts.
- **Ask for trades**: open, close and resize positions, limit and market
  orders, cancel or change orders, take profit and stop loss, leverage and
  margin, spot and prediction orders, vault deposits and withdrawals, moving
  USDC between spot and perps, and withdrawing to one of your own wallets.
  Each request sends a push to the Dreamcash app, where you review exactly
  what will be signed and approve or refuse it. Requests you don't answer
  expire after 15 minutes. Trades pay the same fees as in the app.
- **Trade on its own**, if you turn it on in the app: your main wallet
  approves the agent's key on Hyperliquid once, for the days you pick (up to
  180), and its orders, position changes and HLP moves on your main wallet go
  through without asking you, within your limits per order, on leverage and
  per day. Withdrawals and transfers always wait for you.

Try asking it:

- "How did my positions do this week?"
- "Buy $50 of HYPE at 3x with a stop loss 5% below."
- "Close everything I have open on BTC."

## Set up

You need Node.js 20 or newer and a Dreamcash account (made in the Dreamcash
app for [iPhone](https://apps.apple.com/app/id6748916424) or
[Android](https://play.google.com/store/apps/details?id=xyz.dreamcash.app)).

Add a local (stdio) MCP server that runs:

```sh
npx -y @dreamcash-org/mcp
```

**Claude Code**

```sh
claude mcp add dreamcash -- npx -y @dreamcash-org/mcp
```

**Claude Desktop, Cursor and other clients configured with JSON**

```json
{
  "mcpServers": {
    "dreamcash": {
      "command": "npx",
      "args": ["-y", "@dreamcash-org/mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.dreamcash]
command = "npx"
args = ["-y", "@dreamcash-org/mcp"]
```

**Gemini for Mac**: Customize › Connectors › Add custom app › Local MCP, with
the command `npx -y @dreamcash-org/mcp`.

**Agents that set up their own tools** (Grok Bot, Hermes, OpenClaw): ask
the agent to add a local MCP server that runs `npx -y @dreamcash-org/mcp`.

Desktop apps often start servers without your terminal's `PATH`: if `npx`
isn't found, use its full path, which `which npx` prints in your terminal
(e.g. `/opt/homebrew/bin/npx`).

## Connect your account

1. In the Dreamcash app, open **Settings › Connected AI**. It shows a
   6-character code, valid for 10 minutes.
2. Tell your agent to connect to Dreamcash with that code. It's connected
   at once, and the app lists it under Connected AI.
3. To let it trade on its own, open it in Connected AI, pick its limits (by
   default $1,000 per order, 10x leverage, $5,000 a day) and how many days its
   key lasts, and approve its key with your main wallet.

## Safety

- **Dreamcash holds no key that can trade for you.** Everything you approve is
  signed in the Dreamcash app, which shows exactly what you sign. Read it
  before you approve: an agent can be wrong, or be misled by what it reads.
- **The agent's key stays on its machine.** The first time it connects, this
  server makes a key and saves it in `~/.dreamcash/agent-key.json`, readable
  only by your user. Dreamcash never sees it. Every call the agent makes is
  signed with it, so whoever holds the file can read your account and ask for
  trades as this agent.
- **If you let it trade on its own**, that key becomes an API wallet of your
  main account on Hyperliquid until it expires. Whoever holds the file can
  then trade any market there directly, and deposit into HLP (deposits stay
  locked for 4 days), outside Dreamcash and its limits: your limits bind only
  the trades the agent asks Dreamcash for. It can't withdraw or send your
  funds. So keep the file as safe as the money on your main wallet, and pick a
  short key life. Before it signs a trade, this server checks that it is the
  one the agent asked for, on your main wallet, at prices within 10% of
  Hyperliquid's live price.
- **Give your code only to your own agent.** Anyone who has it in its 10
  minutes can connect their agent to your account; the app tells you each
  time an AI connects.
- **What the agent sees**: the balances, positions and history of every
  wallet in your Dreamcash account.
- **To disconnect** it, swipe it away in Connected AI: the app also revokes
  its key on Hyperliquid when it trades on its own. Deleting the key file
  disconnects this machine too. Pairing again makes a new key in
  `agent-key.json.pending`; the key before it keeps working until the new one
  pairs.

## Troubleshooting

| What the agent reports | What to do |
| --- | --- |
| `dreamcash_unreachable` | Check the machine is online; try again in a minute. |
| `npx` not found | Use its full path (`which npx` prints it), as above. |
| `key_not_saved`, `key_unreadable` | Make the key file readable and writable by the user the agent runs as, or set `DREAMCASH_AGENT_KEY_FILE` to a file that is, then restart the agent. An app that runs servers in a sandbox (e.g. Gemini for Mac) may allow writes only to some folders: put the key file in one of them. Deleting a paired key file disconnects this machine. |
| No Dreamcash tools after connecting | Restart the agent or reload its MCP servers: some clients don't notice new tools by themselves. |
| `code_invalid` | The code expired or was used: read the one the app shows now (Settings › Connected AI) and give it to the agent. |
| `update_required` | Run the server as `npx -y @dreamcash-org/mcp@latest` once (npx may keep using a version it already downloaded), then restart the agent. |

## Settings

| Variable | Default |
| --- | --- |
| `DREAMCASH_AGENT_KEY_FILE` | `~/.dreamcash/agent-key.json` |
| `DREAMCASH_API_URL` | `https://api.dreamcash.xyz` (https only; plain http only for `localhost`) |

## License

MIT. The published file bundles open-source packages; their licenses are in
`dist/THIRD_PARTY_LICENSES.md`.
