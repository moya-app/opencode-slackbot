# Opencode Slackbot

Connect MCPs, skills, document databases etc to slack via OpenCode awesomeness.

Some examples of what it can be used for:

1. Rather than using traditional RAG, dump all the data (markdown etc) files into the data/ directory and add a short
   data/AGENTS.md file to explain the setup.
2. Allow (read-only please!) access to your databases from slack - especially beneficial if you put database
   documentation into data/AGENTS.md and file-per-table markdown into the data/ directory.

# Security

As it's run in a container it should be fully isolated from the rest of your system.

The default opencode configuration file also restricts permissions so that bash cannot be used (which could exfiltrate
your secure container environment variables).

# Setup

1. Copy `app.env.example` to `app.env` and fill in the required values for slack/opencode.
2. Copy `config/opencode.jsonc.example` to `config/opencode.jsonc` and customize as needed — add any MCPs, set the
   model you want to use.
3. Create the `data/` directory with an `AGENTS.md` file and any other files you want to expose to the bot.
4. Follow the Slack setup guide below to create the Slack app and update `app.env` with the tokens.
5. Start the bot:

```bash
docker compose up -d
docker compose logs -f opencode
```

# Slack Setup Guide (one time - it's a bit of a pain...)

## Overview

The connector uses **Socket Mode** which allows real-time messaging without needing a public server or webhook URL. This makes it ideal for running locally or behind a firewall.

## Step 1: Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **"Create New App"**
3. Choose **"From scratch"**
4. Enter an App Name (e.g., "oc-bot" or "OpenCode Bot")
5. Select your workspace
6. Click **"Create App"**

## Step 2: Configure Bot Permissions

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll to **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add these scopes:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Send messages |
| `files:write` | Upload images |
| `channels:history` | Read messages and receive message events in public channels (required for `@mention` replies and channel thread follow-ups) |
| `channels:read` | View channel info |
| `app_mentions:read` | Respond when @mentioned |
| `users:write` | Update own presence info |

Optional scopes for DM support:
| Scope | Purpose |
|-------|---------|
| `im:history` | Read direct message history |
| `im:read` | View direct message info |
| `im:write` | Send direct messages |

## Step 3: Enable Socket Mode

1. In the left sidebar, click **"Socket Mode"**
2. Toggle **"Enable Socket Mode"** to ON
3. You'll be prompted to create an App-Level Token:
   - Name it (e.g., "socket-token")
   - Add scope: `connections:write`
   - Click **"Generate"**
4. **Copy the `xapp-...` token** - this is your `SLACK_APP_TOKEN`

## Step 4: Configure Event Subscriptions

1. In the left sidebar, click **"Event Subscriptions"**
2. Toggle **"Enable Events"** to ON
3. Expand **"Subscribe to bot events"**
4. Click **"Add Bot User Event"** and add:
   - `app_mention` - When users @mention your bot
   - `message.channels` - Messages in public channels
   - `messages.im` - Messages in direct messages

5. Click **"Save Changes"**

## Step 5: Set up direct chat

1. In the left sidebar, click **"App Home"**
2. Scroll to **"Show Tabs"** and enable **"Chat Tab"**
3. Also select the "Allow users to send Slash commands and messages" option

## Step 6: Get the Singing Secret

1. In the left sidebar, click **"Basic Information"**
2. Scroll down to **"App Credentials"**
3. Copy the **"Signing Secret"** - this is your `SLACK_SIGNING_SECRET`

## Step 7: Enable it as an Agent

1. In the left sidebar, click **"Agents & AI Apps"**
2. Turn on **"Agent or Assistant"**

## Step 8: Install to Workspace

1. In the left sidebar, click **"Install App"** (or go to OAuth & Permissions)
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**
4. **Copy the "Bot User OAuth Token"** (`xoxb-...`) - this is your `SLACK_BOT_TOKEN`

## Step 9: Configure Environment

Add the tokens to your `app.env` file:

```bash
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_APP_TOKEN=xapp-your-app-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
```

## Step 10: Add your bot to a channel

1. In Slack, go to the channel you want the bot to join
2. Click on the users list (top right)
3. Click **"Integrations"**
4. Find your bot (e.g., "oc-bot") and click **"Add"**

# Other configuration notes

The default `docker-compose.yml` mounts three directories:

1. `config/` — opencode configuration file (`opencode.jsonc`)
2. `data/` — files exposed to the bot (`AGENTS.md`, markdown, CSVs, etc.)
3. `sessions/` — opencode and slackbot session storage. Persisted across container restarts so the bot remembers
   previous conversations and context.

# Debug Opencode

To debug/see what's happening on the opencode instance connected to slack:

    docker compose exec opencode opencode attach http://localhost:4096

# Local Development

To build and run the image from source rather than pulling from GHCR, use the dev compose file:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
```

This merges `docker-compose.dev.yml` on top of the base file, overriding `image:` with a local `build: .` while
inheriting all volumes, env, and other settings. The built image is tagged `opencode-slackbot:dev` locally so it
won't interfere with a pulled production image.

To run typechecks locally:

```bash
cd app
bun install
bun run typecheck
```

# Publishing

Tagged releases are published to GHCR automatically by the CI workflow when a tag is pushed:

```bash
git tag 1.2.3
git push origin 1.2.3
```

This builds and pushes `ghcr.io/moya-app/opencode-slackbot:1.2.3` and `:latest`

