# BLAXIN — AI Desktop Agent

A futuristic, production-quality AI desktop agent capable of understanding user instructions, planning tasks, interacting with the computer's GUI/desktop, using applications, working with files, using the browser, and completing multi-step tasks.

## Architecture

```
BLAXIN UI (React + Vite)
    ↓
Agent Orchestrator (WebSocket)
    ↓
Provider Abstraction Layer
    ↓
Cloud Provider (OpenRouter/OpenAI/Anthropic/Google/Groq/Together)
    or
Local Provider (Ollama)
    ↓
Model
```

## Features

- **Multi-Provider AI Support**: OpenRouter (first-class), OpenAI, Anthropic, Google, Groq, Together, Ollama
- **Live Model Discovery**: Automatically discovers available models from configured providers
- **Free Model Detection**: Identifies and recommends free models
- **Agent Task Engine**: state machine, step tracking, retry/backoff, provider fallback, loop detection, confirmation gate for high-impact tool actions, and a sequential task queue
- **Task Memory**: persistent, searchable, deletable memory that never stores secrets
- **Desktop Control**: Mouse, keyboard, window management via xdotool/ydotool
- **File System**: Read, write, create, delete files and directories (protected against system/credential paths)
- **Terminal**: Execute shell commands with timeout protection and dangerous-command confirmation
- **Browser**: Open URLs, search the web
- **Screenshots**: Capture screen state for visual observation
- **Clipboard**: Read/write system clipboard
- **System Info**: CPU, memory, disk, network information
- **Secure Credentials**: AES-256-CBC encrypted API key storage
- **Cyberpunk UI**: Futuristic dark theme with neon accents, keyboard focus states and reduced-motion support
- **Error Diagnostics**: Detailed error categorization and resolution guidance

## Getting Started

### Prerequisites

- Node.js 18+
- Linux (for desktop control tools)

### Installation

```bash
cd blaxin

# Install server dependencies
cd server && npm install

# Install client dependencies
cd ../client && npm install
```

### Running

```bash
# Start the server (port 3001)
cd server && npm run dev

# Start the client (port 5173) in another terminal
cd client && npm run dev
```

Open http://localhost:5173 in your browser.

### Configuration

1. Open Settings in the BLAXIN UI
2. Select a provider (OpenRouter recommended for model variety)
3. Enter your API key
4. Click "Validate & Save"
5. Browse available models and select one
6. Start chatting!

## Provider Setup

### OpenRouter (Recommended)
1. Sign up at https://openrouter.ai
2. Create an API key at https://openrouter.ai/keys
3. Enter the key in BLAXIN Settings → Providers

### OpenAI
1. Sign up at https://platform.openai.com
2. Create an API key
3. Enter the key in BLAXIN Settings → Providers

### Anthropic
1. Sign up at https://console.anthropic.com
2. Create an API key
3. Enter the key in BLAXIN Settings → Providers

### Ollama (Local)
1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull llama3`
3. Start Ollama: `ollama serve`
4. No API key needed — BLAXIN auto-detects it

## Tools

| Tool | Description |
|------|-------------|
| `terminal` | Execute shell commands |
| `filesystem` | Read/write/manage files |
| `computer-control` | Mouse, keyboard, window management |
| `screenshot` | Capture screen state |
| `browser` | Open URLs, search web |
| `clipboard` | System clipboard access |
| `search` | Web search |
| `system-info` | System information |

## Security

- API keys are encrypted with AES-256-CBC and stored with 0600 permissions
- Keys are never logged, exposed in errors, or sent to the frontend
- Secrets are masked in all logs and diagnostics, and refused by the memory store
- High-impact tool actions (deletes, destructive shell commands, installs, browser/desktop actions) pause the agent and require explicit user approval before execution
- Filesystem writes/deletes are hard-blocked on system-critical and credential paths (`/etc`, `/boot`, `~/.ssh`, key files, etc.)
- The backend validates the `Origin` of every WebSocket upgrade and state-changing HTTP request; only local/desktop origins are allowed by default (see `BLAXIN_ALLOWED_ORIGINS` below)
- The desktop app binds the bundled backend to `127.0.0.1` only

### Connection origin policy

Browsers always attach an `Origin` header to non-GET requests, so requests with no origin header are treated as trusted local tooling. Any browser-origin request must match:

- localhost / `127.0.0.1` / `[::1]` (any port)
- the Tauri desktop origin (`tauri://localhost`, `http(s)://tauri.localhost`)
- origins listed in `BLAXIN_ALLOWED_ORIGINS` (comma separated)

For a remote web deployment behind a public domain, set e.g. `BLAXIN_ALLOWED_ORIGINS=https://blaxin.example.com`.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default `3001`) |
| `BLAXIN_HOST` | Bind address (desktop sets `127.0.0.1`) |
| `BLAXIN_DATA_DIR` | Directory for config, encrypted credentials and session state (defaults to the working directory when writable, otherwise `~/.local/share/blaxin`) |
| `BLAXIN_ALLOWED_ORIGINS` | Extra allowed browser origins (comma separated) |
| `BLAXIN_SECRET` | Hex key (≥ 64 chars) for encrypting stored credentials; otherwise a machine-derived key is used |

## Memory

BLAXIN keeps a persistent memory store (`.blaxin-state/memory.json` under the data directory) for user preferences, durable facts and failure lessons. Entries are capped in size/count, de-duplicated, and refused when they look like secrets. Manage it from the API: `GET /api/memory`, `DELETE /api/memory`.

## Installer

One-command installation for Linux x86_64 downloads the latest stable release, verifies its checksum and installs it with desktop integration:

```bash
curl -fsSL https://raw.githubusercontent.com/alex34301430/Blaxin/main/blaxin/install.sh | bash
```

The installer is distro-aware:

- **Debian-family distros (Debian / Ubuntu / Kali / Mint / Pop!_OS)**: installs
the `.deb` package via `dpkg` (fixing dependencies with `apt-get install -f` if
needed). The `.deb` runs against the system WebKitGTK, which is the most
reliable configuration.
- **Other distros**: installs the portable AppImage to `/opt/blaxin` with a
launcher and desktop entry, as before.
- Force the AppImage on any distro with `--appimage`:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/alex34301430/Blaxin/main/blaxin/install.sh | bash -s -- --appimage
  ```

## Linux distribution notes

- **Debian / Ubuntu / Kali and other Debian-family distros**: use the `.deb`
  package (`blaxin_<version>_amd64.deb` on the release page) — `install.sh`
  does this automatically. It declares its dependencies
  (`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`) and runs
  against the distro's own WebKitGTK, which is the most reliable configuration.

  ```bash
  sudo apt install ./blaxin_1.1.1_amd64.deb   # or: sudo dpkg -i … && sudo apt-get install -f
  blaxin
  ```

- **AppImage caveat**: the AppImage bundles the WebKitGTK/GTK/GLib stack of the
  CI build machine. On some systems the bundled `WebKitWebProcess` cannot
  initialize EGL and aborts with
  `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`,
  which leaves the window blank (gray/black) even though the bundled backend
  starts fine (`[BLAXIN] Server is ready!` appears). This is a known upstream
  Tauri/WebKitGTK AppImage limitation (tauri#11988) and is not caused by
  BLAXIN's own code — the identical build renders correctly when it runs
  against the system WebKitGTK (e.g. via the `.deb`).

  If the AppImage shows a blank window, use the `.deb` package instead. The
  generic WebKit environment variables (`WEBKIT_DISABLE_DMABUF_RENDERER=1`,
  `WEBKIT_DISABLE_COMPOSITING_MODE=1`) do **not** fix this failure mode.

## Tech Stack

- **Server**: Node.js, TypeScript, Express, WebSocket
- **Client**: React 18, TypeScript, Vite, Zustand
- **Styling**: Custom cyberpunk CSS theme
- **AI**: Multi-provider abstraction (OpenRouter, OpenAI, Anthropic, Google, Groq, Together, Ollama)
