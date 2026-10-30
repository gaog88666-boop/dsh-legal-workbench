# dsh-legal-workbench

A right-sidebar workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It turns your Obsidian notes into a working surface inside the chat window: look up SOPs,
keep a glossary, record meetings with live transcription and annotations, and search everything.

All files stay on your computer. No account, no telemetry. See [PRIVACY.md](./PRIVACY.md).

中文说明见 [README.zh.md](./README.zh.md)。

## Install

```sh
dsh plugin --profile desktop add dsh-legal-workbench
```

Then restart DSH.

## First run

Click the workbench icon next to the session title (or press `⌥W`).
The first time, it asks for one thing: the full path of your Obsidian vault.
Fill it in and press save — that's it.

Nothing else is required. The optional extras (transcription, usage badges, Pkulaw points)
stay dormant until you provide your own credentials.

## What you get

| Card | What it does | Needs |
|---|---|---|
| SOP | Browse your SOP folder as a tree, read and edit notes in place | a vault |
| Glossary | One row per term, edit inline, written back to a note | a vault |
| Recordings | Record, transcribe live, highlight and annotate the transcript, play back | a vault; transcription needs a Volcengine key |
| Search | Full-text search across notes, transcripts and annotations | a vault |
| Email | Draft emails from your own rule library | optional: your own skill folder |
| Usage badge | DeepSeek balance and remaining speech hours | optional: your own keys |

## Where things live

- Your notes and recordings: inside your vault (folders are configurable on the first screen).
- Plugin configuration: `~/.dsh-workbench/config.json`.
- Optional credentials: `~/.dsh-workbench/asr.json` (mode 600, never in this repo).

## Keyboard

- `⌥W` — open or close the workbench wherever you are
- `Esc` — close it

## Notes

- The right sidebar is per-session in DSH. If the workbench cannot dock there, it opens as an
  overlay instead of failing silently.
- Transcription is off unless you configure a Volcengine key; recording and playback work without it.

## License

MIT
