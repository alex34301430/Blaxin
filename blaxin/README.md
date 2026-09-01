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
- **Desktop Control**: Mouse, keyboard, window management via xdotool
- **File System**: Read, write, create, delete files and directories
- **Terminal**: Execute shell commands with timeout protection
- **Browser**: Open URLs, search the web
- **Screenshots**: Capture screen state for visual observation
- **Clipboard**: Read/write system clipboard
- **System Info**: CPU, memory, disk, network information
- **Secure Credentials**: AES-256-CBC encrypted API key storage
- **Cyberpunk UI**: Futuristic dark theme with neon accents
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

- API keys are encrypted with AES-256-CBC
- Keys are never logged, exposed in errors, or sent to the frontend
- Destructive actions require confirmation
- Secrets are masked in all logs and diagnostics

## Tech Stack

- **Server**: Node.js, TypeScript, Express, WebSocket
- **Client**: React 18, TypeScript, Vite, Zustand
- **Styling**: Custom cyberpunk CSS theme
- **AI**: Multi-provider abstraction (OpenRouter, OpenAI, Anthropic, Google, Groq, Together, Ollama)
