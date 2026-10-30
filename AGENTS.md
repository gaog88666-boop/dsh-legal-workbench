# Maintenance notes

Internal notes for whoever maintains this plugin. User-facing docs are in `README.md` / `README.zh.md`.

## Layout

```
index.js            Host half: HTTP routes under /api/dsh-workbench (loopback only)
client.js           Browser half: slots + the whole panel UI
cordis.patch.yml    Bundle layer config (all paths optional; empty means "ask the user")
lib/
  vault.js          the only way into the vault: discover / read / write / conflict / deep link / tree
  cards.js          cards.json validation, falls back to built-in cards
  prompts.js        prompts.json templates
  glossary.js       glossary parse / validate / backup / atomic write
  email.js          read-only stats for an optional email rules library
  email-rules.js    parse + rewrite that rules library without touching unrelated text
  recordings.js     WAV assembly, chunk append, peaks, transcript, annotations
  volc-asr.js       Volcengine streaming ASR bridge (sessions / chunks / finals), hotword table
  iflyrec.js        iFlytek local MCP client (whole-file transcription)
  volc-ws.js        minimal WebSocket client (custom handshake headers required)
test/               node test/all.mjs
locale/             zh / en display names
```

Data: notes and recordings live in the user's vault; config and credentials live in
`~/.dsh-workbench/` (config.json, optionally asr.json with mode 600).

## Slots

| Slot | Key | Purpose |
|---|---|---|
| `conversation.session.header.actions` | id `dsh-workbench` | icon button next to the session title |
| `conversation.hero.options` | id `dsh-workbench` | entry on empty sessions |
| `sidebar.right.pane.tab` | key `dsh-workbench.panel` | the panel body inside the right sidebar |
| `shell.overlay` | id `dsh-workbench-full` | overlay fallback, toggled by `⌥W` |

## Non-negotiables

1. **Never call `layout.openRightbar()`.** Forcing the sidebar open leaves a "shown but empty"
   column; the host then hides its own sidebar toggle and the whole right pane looks gone.
   Try `sidebarRight.openResource()` first; if it throws, open the overlay instead.
2. **Never reference the recorder's `sessionRef`/`statusRef` from the panel component.** That
   mistake throws on unmount and takes down the entire sidebar, including file previews.
3. **Panel render is wrapped in try/catch** so one bad card cannot blank the pane. Client errors
   are forwarded to `<dataDir>/client-errors.log`.
4. **Loopback fence** on every route: remote address + Host header + same-origin.
5. **Compare-and-swap writes**: `PUT /sop/note` carries `expectedSha1`; mismatch returns 409.
6. **Backups go to `.backups/`**, never next to the note.
7. **Deep links go through the Host** (`POST /open-obsidian`); the Web shell drops `obsidian://`.
8. **No path escapes the vault**: `resolveInside` rejects absolute paths and `..`.
9. **Credentials never leave the machine and never appear in responses.**

## Recording and transcription

- Audio is assembled into WAV in the browser (16k/16bit/mono) and appended chunk by chunk;
  the header is patched at finalize, and `list()` repairs orphaned headers.
- WebSocket lives in the Host because Volcengine authenticates via handshake headers.
- The session timeout is **idle-based**. Never make it absolute again — that cut every
  recording longer than 2 minutes.
- Pause ends the current transcription segment; resume starts a new one with `offsetMs`, and the
  server appends to the same `转写.md`.
- Silent for 2 minutes → the ASR session is finished (quota saved); speech resumes → new session.
- `No audio was received` is a benign end-of-segment signal, not a failure.
- Hotwords: optional `volcengine.boostingTableId` in `asr.json`, sent as `corpus.boosting_table_id`.
  Without it, tables configured in the console have no effect.

## What takes effect when

| Change | How it applies |
|---|---|
| `cards.json` / `prompts.json` / glossary / notes | page refresh (read per request) |
| `client.js` | restart DSH (the packaged build has no reload shortcut) |
| `index.js` / `lib/*` | restart DSH |
| `cordis.patch.yml` | restart DSH |
| First-run config saved from the panel | immediate (stores are rebuilt in place) |

## Testing

```bash
node test/all.mjs
```

## Known gaps

- Images in notes are not rendered; they appear as a filename label.
- Markdown rendering is minimal (headings, lists, bold, code, wikilinks, frontmatter).
- Annotations anchor to the start line of a multi-line selection; highlight color is fixed.
- Reimbursement card only checks that a template exists.
- No progress bar when transcribing an imported audio file.
