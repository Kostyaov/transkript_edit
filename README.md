# Offline Transcript Editor

Offline Transcript Editor is a local web application for editing audio-synchronized transcripts that were already produced by an external transcription service, especially TurboScribe. The project intentionally does not perform speech-to-text transcription itself. Its job is to make cleanup, speaker correction, sentence editing, audio review, and export comfortable while keeping all files on the local machine.

Current development status: working MVP / early editor prototype. The core offline workflow is implemented and usable, but the application is not yet packaged, authenticated, tested with a formal test suite, or optimized for very large projects.

## Product Goal

The app should let a user:

1. Import an audio file.
2. Import a transcript file, preferably TurboScribe CSV.
3. Edit transcript text sentence by sentence.
4. Correct speakers from a dropdown built from speakers in the transcript.
5. Click a segment and play audio from that timestamp.
6. See the active segment while listening.
7. Save work locally and resume it later.
8. Export the cleaned transcript in useful formats.

The strongest current workflow is CSV-first:

```csv
"start","end","text","speaker"
"0","970","Що Ви хочете сказати?","Мовець 8"
"1690","3730","Які Ваші очікування?","Мовець 8"
```

TurboScribe CSV exports `start` and `end` in milliseconds. Internally this app stores times as seconds.

## Current Features

- Local FastAPI backend and static HTML/CSS/JS frontend.
- Import audio plus transcript.
- Preferred transcript import: CSV with `start,end,text,speaker`.
- Additional imports: SRT, VTT, JSON, TurboScribe speaker TXT, plain TXT fallback.
- Sentence/segment-level editing.
- Editable speaker per segment via real dropdown/select.
- Speaker dropdown options are derived from unique speakers in the current project.
- Speaker-specific row background colors.
- Stronger active-row highlight during playback.
- Audio player with playback-rate control.
- Toggle timing controls on/off to give the text editor more horizontal space.
- Click `Play` on a segment to start audio from that segment.
- Active segment follows `audio.currentTime`.
- Textareas auto-expand so each text block is visible.
- Search across speaker and text.
- Add segment near the current selected/audio position.
- Split text at caret; focus moves to the newly split text.
- Merge selected segment with next segment.
- Previous/Next segment navigation.
- Listening mode shortcuts: `Space` pauses/resumes audio from the current position; `0-9` assigns speaker by dropdown order.
- Text editing mode shortcuts: `Enter` exits editing; `Cmd+Enter` / `Ctrl+Enter` inserts a new line.
- `Cmd+S` / `Ctrl+S` saves the local project state.
- Recent projects list.
- Export as CSV, TXT, SRT, VTT, JSON.
- Unicode-safe filenames for Cyrillic names.

## What Save Means

The `Save` button and `Cmd+S` / `Ctrl+S` save the current project state to local app storage:

```text
data/projects/{project_id}/project.json
data/projects/{project_id}/audio/{audio_filename}
```

This does not overwrite the source CSV/TXT/SRT in Downloads or anywhere else. It saves the editable working state so the user can reopen it from `Recent projects`.

To create an external output file, use one of the export buttons:

- `CSV`: technical round-trip format with timestamps and speakers.
- `TXT`: readable grouped transcript without timestamps.
- `SRT`: subtitle format with speaker prefix.
- `VTT`: web subtitle format with voice tags.
- `JSON`: full project metadata and segments.

## Export Behavior

### CSV

CSV is the main technical export. It writes:

```csv
"start","end","text","speaker"
```

- `start` and `end` are exported in milliseconds.
- `text` is exported as edited.
- `speaker` is exported as edited.

### TXT

TXT is a readable transcript export, not a technical timestamp export.

It:

- removes all timestamps;
- groups consecutive segments by speaker;
- writes one `[Speaker]` header per consecutive speaker block;
- writes each segment text on its own line;
- removes spaces before punctuation;
- appends a period if a line does not end with `.`, `!`, `?`, `…`, `:`, or `;`.

Example:

```text
[Сергій]
Мені цікаво просто, що це люди самі себе, молоді люди самі себе подають, правильно?
Заповнюють гуглформу, кажуть, що ми хочемо. І наскільки цей процес активний?
Часто подаються?

[Мовець 2]
Подаються часто, обираються рідше.
По засіданнях зазвичай проходять раз на місяць або рідше.
```

### SRT

SRT keeps timestamps and adds the speaker into the text:

```text
1
00:00:00,000 --> 00:00:00,970
Мовець 8: Що Ви хочете сказати?
```

### VTT

VTT keeps timestamps and writes speaker voice tags:

```text
WEBVTT

00:00:00.000 --> 00:00:00.970
<v Мовець 8>Що Ви хочете сказати?
```

### JSON

JSON exports the full project object:

```json
{
  "id": "project-id",
  "audio_filename": "audio.mp3",
  "transcript_filename": "transcript.csv",
  "segments": [
    {
      "id": 1,
      "start": 0.0,
      "end": 0.97,
      "speaker": "Мовець 8",
      "text": "Що Ви хочете сказати?"
    }
  ]
}
```

## Internal Data Model

The normalized segment model is:

```json
{
  "id": 1,
  "start": 0.0,
  "end": 0.97,
  "speaker": "Мовець 8",
  "text": "Що Ви хочете сказати?"
}
```

Important details:

- `id` is local and renumbered after edits.
- `start` and `end` are stored in seconds.
- CSV import/export converts milliseconds to/from seconds.
- Segments are sorted by `start`.
- Speaker may be empty, but CSV/TXT workflows are most useful when it is populated.

## Architecture

```text
.
├── app/
│   ├── __init__.py
│   ├── main.py          # FastAPI app, project storage, API endpoints, static serving
│   └── subtitles.py     # transcript parsers, normalizer, exporters
├── static/
│   ├── index.html       # UI structure and templates
│   ├── app.js           # client-side editor behavior
│   └── styles.css       # layout, speaker colors, responsive styles
├── data/
│   └── projects/        # local project storage, ignored by git
├── requirements.txt
├── .gitignore
└── README.md
```

## Backend

Backend stack:

- Python 3.12 used during development.
- FastAPI.
- Uvicorn.
- No database yet. Projects are filesystem-backed JSON folders.
- No multipart dependency. Audio upload uses raw `PUT` request body.

### Main API

```text
GET    /api/health
GET    /api/projects
POST   /api/projects
PUT    /api/projects/{project_id}/audio
GET    /api/projects/{project_id}
PATCH  /api/projects/{project_id}
DELETE /api/projects/{project_id}
GET    /api/projects/{project_id}/audio
GET    /api/projects/{project_id}/export/{format_name}
GET    /
```

### POST /api/projects

Creates project metadata from an audio filename and transcript text. Audio bytes are uploaded separately.

Payload:

```json
{
  "audio_filename": "audio.mp3",
  "audio_type": "audio/mpeg",
  "transcript_filename": "transcript.csv",
  "transcript_text": "...raw transcript text..."
}
```

Response is the project JSON with parsed `segments`.

### PUT /api/projects/{project_id}/audio

Uploads raw audio bytes. The frontend sends the original filename in `X-Filename`. Because HTTP headers must be Latin-1-compatible in browsers, the frontend URL-encodes the filename, and the backend decodes and normalizes it.

### PATCH /api/projects/{project_id}

Saves edited segments:

```json
{
  "segments": [
    {
      "id": 1,
      "start": 0.0,
      "end": 0.97,
      "speaker": "Мовець 8",
      "text": "Edited text"
    }
  ]
}
```

### GET /api/projects/{project_id}/export/{format_name}

Supported `format_name` values:

- `csv`
- `txt`
- `srt`
- `vtt`
- `json`

Downloads use RFC 5987-style UTF-8 `filename*` headers so Cyrillic filenames work.

## Frontend

Frontend stack:

- Static HTML.
- Plain CSS.
- Plain JavaScript module.
- Native `<audio>` element.
- No bundler.
- No frontend framework.

Important UI behavior lives in `static/app.js`:

- `createProject()` reads transcript text and creates a project.
- `uploadAudio` is done by raw `PUT`.
- `renderSegments()` rebuilds segment rows.
- `getSpeakers()` derives dropdown options from current segments.
- `syncSpeakerColors()` assigns stable speaker colors.
- `syncActiveSegment()` highlights the currently playing segment.
- `saveProject()` persists JSON state.
- `exportProject()` downloads selected export format.

## Supported Imports

### CSV

Recommended and primary format.

Required columns:

```text
start,end,text
```

Optional column:

```text
speaker
```

The expected TurboScribe-style CSV has:

```csv
"start","end","text","speaker"
"1690","3730","Які Ваші очікування?","Мовець 8"
```

Numeric start/end values >= 100 are treated as milliseconds. Timecode strings with `:` are also accepted.

### TurboScribe TXT Speaker Transcript

Supported pattern:

```text
[Мовець 5] (0:24 - 1:33)
Text...
```

This imports as one segment per speaker block, not sentence-level. CSV is better for sentence-level editing.

### SRT and VTT

Supported for compatibility. Speaker data is not recovered from ordinary SRT/VTT unless it is embedded in the text by the user/export source.

### JSON

Accepts either:

- a list of segment objects;
- an object with a `segments` array.

### Plain TXT

Fallback only. The app splits paragraphs into segments and estimates timing. This is not recommended for accurate audio sync.

## Current Development Stage

Implemented and working:

- Local server.
- Import pipeline.
- CSV-first segment model.
- Local project persistence.
- Audio sync and segment playback.
- Text editing.
- Speaker editing through dropdown.
- Speaker-colored rows.
- Add, split, merge.
- Recent projects.
- Keyboard save.
- Basic export formats.

Partially implemented / rough:

- UI is functional but still utilitarian.
- Recent project list can contain duplicate projects if the user repeatedly imports/export-reimports files.
- No project rename UI.
- No explicit delete button in frontend, although backend supports DELETE.
- No undo/redo.
- No bulk speaker rename.
- No formal automated tests.
- No packaged desktop/offline installer.
- Large projects may rerender many rows because the frontend currently rebuilds the full segment list after many edits.

Not in scope right now:

- Speech-to-text transcription.
- Whisper integration.
- Cloud sync.
- Multi-user editing.

## Known Design Decisions

- CSV is now the main workflow because it preserves sentence-level timing and speaker names better than SRT for multilingual/speaker-heavy transcripts.
- `Save` means local project save, not export.
- Export is explicit through format buttons.
- The app stores editable projects as JSON because it is easier to preserve state than repeatedly mutating CSV.
- Audio is stored inside each project folder so recent projects can reopen without asking for the source file again.
- The frontend uses a full rerender approach for simplicity.
- Speaker colors are assigned in first-seen order from the current project and are not persisted as user settings.

## Running Locally

The app is a local Python web server plus static frontend. It does not need a cloud account or external API. Audio files and edited projects are stored on the same machine in `data/projects/`.

Recommended prerequisites:

- Python 3.11 or newer. Python 3.12 was used during development.
- Git, if cloning from GitHub.
- A modern browser: Chrome, Edge, Firefox, or Safari.

Clone the repository:

```bash
git clone https://github.com/Kostyaov/transkript_edit.git
cd transkript_edit
```

If you downloaded the repository as a ZIP instead, unzip it and open a terminal in the extracted `transkript_edit` folder.

### macOS

Check Python:

```bash
python3 --version
```

Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install dependencies:

```bash
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
```

Run:

```bash
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Open:

```text
http://127.0.0.1:8001/
```

### Windows

Check Python in PowerShell:

```powershell
py --version
```

Create and activate a virtual environment:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
```

If PowerShell blocks activation scripts, run this once for the current terminal session and activate again:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\.venv\Scripts\Activate.ps1
```

Install dependencies:

```powershell
py -m pip install --upgrade pip
py -m pip install -r requirements.txt
```

Run:

```powershell
py -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Open:

```text
http://127.0.0.1:8001/
```

Windows keyboard note: shortcuts that use `Cmd` on macOS use `Ctrl` on Windows, for example `Ctrl+S` and `Ctrl+Enter`.

### Linux

Check Python:

```bash
python3 --version
```

Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

If `venv` is missing on Debian/Ubuntu, install it first:

```bash
sudo apt install python3-venv
```

Install dependencies:

```bash
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
```

Run:

```bash
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

Open:

```text
http://127.0.0.1:8001/
```

### Port Notes

The development session has been using port `8001` because port `8000` was already occupied by another local app. If `8001` is busy on your machine, choose another port:

```bash
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8002
```

Then open:

```text
http://127.0.0.1:8002/
```

## Verification Commands

Syntax checks:

```bash
python3 -m py_compile app/main.py app/subtitles.py
node --check static/app.js
```

Quick CSV parser smoke test:

```bash
python3 -c "from pathlib import Path; from app.subtitles import parse_transcript; p=Path('/path/to/file.csv'); print(len(parse_transcript(p.name, p.read_text(encoding='utf-8'))))"
```

## Filesystem Notes

Project data is ignored by git:

```text
data/projects/
```

This folder may contain user audio and transcript content. Do not commit it.

Python cache files are also ignored:

```text
__pycache__/
*.pyc
```

## Suggested Next Steps

High-value product improvements:

1. Add bulk speaker rename: rename `Мовець 2` to a real name across all segments.
2. Add delete segment UI.
3. Add undo/redo for text, speaker, split, merge, and timing edits.
4. Add project rename and duplicate cleanup in `Recent projects`.
5. Add autosave with a clear debounce and status.
6. Add keyboard shortcuts documentation inside the app.
7. Add virtualized rendering for large transcripts.
8. Add tests for CSV/TXT/SRT/VTT import/export.
9. Add a “clean transcript” export options panel.
10. Package as a simple local desktop app or one-command launcher.

Likely technical cleanup:

1. Move frontend state operations into small pure functions that are easier to test.
2. Add a project schema/version field for future migrations.
3. Store user speaker color preferences if colors become semantically meaningful.
4. Add better validation for overlapping segments and empty timestamps.
5. Add import warnings for malformed CSV rows.

## Handoff Summary

If another AI or developer opens this repo: continue from a working CSV-first offline transcript editor. Do not add transcription yet unless the user explicitly asks. The user’s current priority is ergonomic cleanup of already-transcribed audio, especially Ukrainian/multilingual speaker transcripts exported by TurboScribe. Preserve local/offline behavior and keep CSV as the primary round-trip format.
