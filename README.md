# Bandwidth Governor

**Free & open-source Windows app to keep your internet stable while running Claude Code.**

Built by someone who ran Claude Code so hard and so regularly that his internet started having issues. Bandwidth Governor uses Windows QoS policies to rate-limit upload/download bandwidth per-app or globally — so Claude can keep coding while your Zoom calls, streaming, and browsing stay smooth.

## Features

- **One-click presets** — Upload-only or balanced bandwidth profiles
- **Per-app limiting** — Throttle specific executables (e.g. node.exe, git.exe, OneDrive)
- **Custom rules** — Set precise upload/download Mbps caps with named policies
- **Claude Code integration** — Auto-detect upload speed and cap Claude-related processes
- **System tray** — Runs in background with quick toggle on/off
- **Live bandwidth monitor** — Real-time upload/download Mbps display
- **Speed test** — Built-in speed test using Cloudflare endpoints
- **Project launchers** — Launch Claude Code sessions in configured project folders
- **Prompt backlog** — Queue and manage prompts for Claude sessions

## Download

Grab the latest portable `.exe` from [Releases](https://github.com/Nimba-Solutions/Bandwidth-Governor/releases).

No installation required — just run as Administrator.

## Requirements

- Windows 10/11
- Must run as Administrator (QoS policies require elevation)

## Build from source

```bash
npm install
npm run build
```

The portable `.exe` appears in `dist/`.

## Development

```bash
npm start
```

## How it works

Bandwidth Governor creates Windows QoS (Quality of Service) policies via `New-NetQosPolicy` PowerShell commands. Policies are stored in the ActiveStore and persist across app restarts via electron-store.

## License

[BSL 1.1](LICENSE.md) — Converts to Apache 2.0 after four years per release.

**Author:** [Cloud Nimbus LLC](https://cloudnimbusllc.com)
