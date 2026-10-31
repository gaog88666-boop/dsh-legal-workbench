# dsh-legal-workbench

A right-sidebar workbench for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
It turns your Obsidian notes into a working surface inside the chat window: look up SOPs,
keep a glossary, record meetings with live transcription and annotations, and search everything.

All files stay on your computer. No account, no telemetry. See [PRIVACY.md](./PRIVACY.md).

中文说明见 [README.zh.md](./README.zh.md)。

## Install

**Requires** a DSH installation (0.2.0 or newer — check with `dsh --version`) and network access
(the package comes from npm).

Pick the command that matches your DSH:

**DSH Desktop app**

```sh
dsh plugin --profile desktop add dsh-legal-workbench
```

**Self-hosted DSH Web** (on your server)

```sh
dsh plugin --profile web add dsh-legal-workbench
```

Using a custom profile name? Replace `desktop` / `web` with yours (see `~/.dsh/profiles/`).

Then **restart DSH** and click the workbench icon next to the session title, or press `⌥W`.

No Obsidian required, no API keys, no account.

> Fully verified on macOS only. Other platforms install and run, but the two actions that call
> system commands ("open in Obsidian", "open console") may need a config tweak.

## First run

Click the workbench icon next to the session title (or press `⌥W`).
The first time, it asks for one thing: the full path of a folder holding your Markdown notes
(an Obsidian vault, or any folder — the plugin only touches `.md` files).
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


## Known limitations

- **Images in notes are not rendered.** They appear as a filename label (e.g. `图片 photo.png`).
  Everything else in a note (headings, lists, bold, code, tables as text, wikilinks) is shown.
- Markdown support is deliberately minimal: no HTML, no embedded PDFs, no mermaid rendering.
- Annotations anchor to the **first line** of a multi-line selection.
- Highlight colour is fixed (yellow); the storage supports more, the UI does not expose it yet.
- The reimbursement card only checks that a template exists; it does not parse it yet.
- Transcribing an imported audio file shows no progress bar.
- The workbench reads and writes the vault directly. Edits made in Obsidian appear after a refresh,
  and edits made here appear in Obsidian immediately (same files).
- DSH gives each session its own right sidebar; if the workbench cannot dock there it opens as an
  overlay instead of failing silently.

## License

MIT
