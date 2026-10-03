# ccserver

**Languages:** [日本語](README.md) | [English](README.en.md) | [Français](README.fr.md)

> **Context & Coordination Server**: a web server for managing context in AI CLI sessions and coordinating multiple agents.

> **Note:** This is an unofficial third-party tool. It is not affiliated with, officially supported by, or endorsed by the vendors or projects of the supported AI CLIs.

ccserver is a web frontend for launching and managing AI CLIs in a selected directory: [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [opencode](https://opencode.ai/), and [OpenAI Codex CLI](https://developers.openai.com/codex/cli/). Select a folder like in VS Code and work in a browser-based terminal.

## Architecture

```
Browser (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> AI CLI
                  <── HTTP REST ──>       (directory API)
```

| Layer | Stack |
|---|---|
| Frontend | React 19 + Vite + xterm.js |
| Backend | Node.js + Fastify + @fastify/websocket + node-pty |

## Requirements

- Node.js >= 22.13 and npm >= 9 (uses the built-in `node:sqlite`; the server opens SQLite (`~/.local/share/ccserver/ccserver.sqlite3`) at startup and refuses to boot with a clear log when a migration fails)
- A C++ compiler for building `node-pty` (`base-devel` on Arch, `build-essential` on Ubuntu)
- At least one supported AI CLI installed on the server. Only installed CLIs can be selected.
- Optional: `bwrap` (bubblewrap), rootless Docker, `rootlesskit`, `uidmap`, and `slirp4netns` for the full sandbox features

Install the CLIs separately by following their official documentation. Claude Code is also used by the Usage feature; opencode and Codex can be used independently.

## Installation and Startup

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
npm run setup           # dry run: shows where config/state will live
npm run setup -- --yes  # create them
```

`npm run setup` is required once per host, including on a fresh install. It creates
`~/.config/ccserver`, `~/.local/share/ccserver` and `~/.local/state/ccserver` (XDG), and on an
existing installation it migrates config and state out of the repository tree. Until it has run,
the Web UI refuses to create new sessions. Run it with the server stopped. See
[Configuration](#configuration).

### Development

Run these commands in two terminals:

```bash
# Backend (port 3001)
npm run dev:server

# Frontend (port 5173)
npm run dev:client
```

Open <http://localhost:5173>.

### Production

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

> **Note:** If your shell has `NODE_ENV=production` set, `npm install` / `npm ci` skip devDependencies (vite etc.) and `npm run build --workspace=client` fails with `vite: not found`. Install with `npm install --include=dev` in that case. Sessions launched by ccserver do not inherit `NODE_ENV` / `PORT` / `CCSERVER_*` (they are stripped as server-only variables).

Open <http://localhost:3001>. Change the port with `PORT`, for example `PORT=8080 NODE_ENV=production node server/index.js`.

## Usage

1. Select a folder in the directory browser. Single-click navigates into a folder; double-click launches the default application in that folder.
2. Use the terminal in the browser.
3. Choose Claude Code, opencode, or OpenAI Codex from the launch menu. Sandboxing, GPG signing, and SSH-agent forwarding are optional launch settings.

The selected application and launch options are remembered in the browser. Codex receives MCP configuration per process; ccserver does not modify `~/.codex/config.toml`.

Scheduled prompts can be created with the clock button in the terminal header. They persist in `~/.local/state/ccserver/scheduled-prompts.json` (overridable with `CCSERVER_SCHEDULES_PATH`) and can fire after the browser closes or the server restarts.

## MCP Tools

- `ccserver-notify` provides `notify`, `subscribe`, `unsubscribe`, and `list_subscriptions` for Discord, webhook, and PWA notifications.
- `ccserver-usage` provides `get_usage` for Claude Code usage snapshots. It is injected only into Claude sessions and only when `usageMcp: true` is enabled.

## Sandbox

Choosing **Launch in sandbox** starts the CLI under `bwrap`. Only the selected project and explicitly allowed configuration directories are visible; neighboring projects are not exposed. When available, rootless Docker runs inside the sandbox as well.

Sandbox HOME directories are persistent per project by default, under `~/.local/share/ccserver-sandbox/home/`. This tree deliberately stays where it is after the XDG migration (persistent HOMEs and review worktrees contain absolute paths; see [Configuration](#configuration)). Set `persistentHome: false` for a fresh temporary HOME on every session. Persistent HOME directories can contain tools, caches, and shell configuration, so treat them as writable state belonging to that project.

For Docker support on Debian/Ubuntu:

```bash
sudo apt install uidmap slirp4netns
```

GPG forwarding, SSH-agent forwarding, and the git/`gh` broker are independent options. SSH-agent forwarding gives every process in the sandbox access to the forwarded agent, so leave it disabled unless an SSH remote or direct SSH access is required.

## Configuration

ccserver splits its settings in two, and which half a setting belongs to is decided by one test:
**does the safety of an already running session depend on it?** If yes, it is static.

- **Dynamic** -- changeable from the Web UI, effective immediately: stored in the SQLite
  `settings` table.
- **Static** -- read once at startup, requires a restart, notably the security boundaries
  (`browseRoots`, `forceSandbox`, `hiddenApps`): stored in
  `~/.config/ccserver/sandbox.config.json`.

`npm run setup` creates that file for you:

```bash
npm run setup -- --yes
$EDITOR ~/.config/ccserver/sandbox.config.json
# Optional alternate path:
# CCSERVER_SANDBOX_CONFIG=/path/to/config.json
```

The generated file is minimal on purpose. Copying `server/sandbox.config.example.json` verbatim
would enable `"gpg": true`, silently forwarding the host gpg-agent and `~/.gnupg` into every
sandbox; use `npm run setup -- --yes --seed-example` if you want the full annotated example
anyway. `server/sandbox.config.example.json` documents every key and its default.

Example:

```json
{
  "docker": true,
  "persistentHome": true,
  "gpg": false,
  "sshAgent": false,
  "gitBroker": true,
  "forceSandbox": false,
  "defaultApp": "claude",
  "showUsage": true,
  "usageMcp": false,
  "notify": { "discordWebhook": "", "subscriptions": [] },
  "binds": [],
  "env": {}
}
```

Important options include `docker`, `persistentHome`, `gpg`, `sshAgent`, `gitBroker`, `forceSandbox`, `defaultApp`, `showUsage`, `usageMcp`, `binds`, and `env`. See the Japanese README for the complete option reference and security limitations.

Every path ccserver uses can be overridden with an environment variable
(`CCSERVER_DB_PATH`, `CCSERVER_SCHEDULES_PATH`, ...); a path with an
override set is never touched by `npm run setup`. The full list, and the reasoning behind the
dynamic/static split, is in the documentation site under Reference -> 設定モデル.

## API

Set `CCSERVER_TOKEN` to protect all `/api` and `/ws` requests. Clients may provide `?token=<TOKEN>` or `Authorization: Bearer <TOKEN>`.

```bash
CCSERVER_TOKEN=some-secret NODE_ENV=production node server/index.js
```

For a per-device passkey (WebAuthn) login with SSH-issued one-time-token recovery instead of a single shared token, set `CCSERVER_AUTH_MODE=passkey` (`none`/`token` remain unchanged and stay the default when unset). See the [auth guide](https://nananek.github.io/ccserver/guides/auth/) (Japanese) for the WebAuthn environment constraints.

Available REST endpoints include:

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dirs?path=<path>&showHidden=1` | List directory contents |
| GET | `/api/dirs/home` | Get home directory and available CLIs |
| POST | `/api/dirs` | Create a folder |
| GET / DELETE | `/api/sessions[/:id]` | List or stop sessions |
| GET / POST | `/api/files` | Download or upload files |
| GET | `/api/files/content?path=<path>` | Inline preview of a `.md` / `.txt` file as JSON (`{ path, name, size, mtime, kind, content, truncated }`; first 1 MiB; other extensions and binaries rejected with 415) |
| GET | `/api/system-stats` | CPU, memory, temperature, GPU, and storage stats |
| GET | `/api/usage?force=1` | Claude Code usage snapshot |

Terminal I/O and session management use the WebSocket endpoint `/ws/terminal`.

## Running with systemd

Build the client, run the setup wizard, then install the included unit file:

```bash
npm run build --workspace=client
npm run setup -- --yes
mkdir -p ~/.config/systemd/user
cp docs/ccserver.service ~/.config/systemd/user/ccserver.service
systemctl --user daemon-reload
systemctl --user enable --now ccserver
systemctl --user status ccserver
```

### Upgrading

```bash
systemctl --user stop ccserver     # migrate with the server stopped
git pull
npm ci
npm run build --workspace=client
npm run setup                      # review the plan first
npm run setup -- --yes
systemctl --user start ccserver
```

After migrating, always start ccserver from a checkout that includes this layout. Older
branches resolve the pre-migration paths and would start with empty state.

## HTTPS with Tailscale Serve

After ccserver is running, expose port 3001 to your Tailnet:

```bash
sudo tailscale serve --bg 3001
tailscale serve status
```

## License

MIT
