# Blaxin

**Blaxin — Open-source AI Desktop Agent for Linux.**

Blaxin is an autonomous AI assistant that lives on your Linux desktop: it understands plain-language instructions, plans multi-step tasks, and then actually does them — driving the terminal, the file system, the GUI, the browser and your applications, with an explicit confirmation gate before anything high-impact.

<p align="center">
  <a href="https://github.com/tasinxxx/Blaxin/releases">Releases</a> ·
  <a href="blaxin/README.md">Documentation</a> ·
  <a href="blaxin/docs/models.md">Local models</a> ·
  <a href="blaxin/docs/distributed-brain.md">Distributed Brain</a> ·
  <a href="blaxin/docs/oci.md">Oracle Cloud</a>
</p>

## Highlights

- **Multi-provider AI** — OpenRouter, OpenAI, Anthropic, Google, Groq, Together, and Ollama
- **Local-first** — run models on your own machine with Ollama: real hardware discovery, a curated model catalog, and a recommendation that actually fits your CPU/RAM/GPU
- **Desktop control** — mouse, keyboard, window management, screenshots, clipboard, browser
- **Distributed Brain** — split the reasoning "Brain" from the executing "Body" across devices, with authenticated, encrypted pairing
- **Cloud inference (optional)** — provision an Oracle Cloud node and reach its model endpoint over a loopback SSH tunnel
- **Security by design** — encrypted credential storage, origin-checked APIs, hard-blocked system paths, and approval gates for destructive actions

## Install (Linux x86_64)

Grab a package (`.deb` or AppImage) from the [releases page](https://github.com/tasinxxx/Blaxin/releases), or use the one-command installer:

```bash
curl -fsSL https://raw.githubusercontent.com/tasinxxx/Blaxin/main/blaxin/install.sh | bash
```

Full setup, provider configuration and platform notes: **[blaxin/README.md](blaxin/README.md)**.

## Documentation

| Document | Contents |
|---|---|
| [blaxin/README.md](blaxin/README.md) | Full user guide: features, providers, security, environment variables |
| [blaxin/docs/models.md](blaxin/docs/models.md) | Local model system: inventory, catalog, recommendation, runtime lifecycle |
| [blaxin/docs/oci.md](blaxin/docs/oci.md) | Oracle Cloud inference: security model, provisioning, secure tunnels |
| [blaxin/docs/distributed-brain.md](blaxin/docs/distributed-brain.md) | Brain/Body architecture, pairing, protocol, Multi-Body |
| [blaxin/docs/branding.md](blaxin/docs/branding.md) | Logo asset, icon generation, packaging usage |

## Tech

Node.js + TypeScript backend, React 18 + Vite desktop UI, WebSocket agent orchestration, Tauri packaging for Linux.
