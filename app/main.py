from __future__ import annotations

import json
import mimetypes
import re
import shutil
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote

from fastapi import Body, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.subtitles import export_csv, export_srt, export_txt, export_vtt, parse_transcript, renumber_segments


ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data" / "projects"
DATA_DIR.mkdir(parents=True, exist_ok=True)


app = FastAPI(title="Offline Transcript Editor")


class ProjectCreate(BaseModel):
    audio_filename: str = Field(min_length=1)
    audio_type: str | None = None
    transcript_filename: str = Field(min_length=1)
    transcript_text: str = Field(min_length=1)


class ProjectUpdate(BaseModel):
    segments: list[dict[str, Any]]


def project_dir(project_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", project_id):
        raise HTTPException(status_code=404, detail="Project not found")
    directory = DATA_DIR / project_id
    if not directory.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    return directory


def metadata_path(project_id: str) -> Path:
    return project_dir(project_id) / "project.json"


def read_project(project_id: str) -> dict[str, Any]:
    path = metadata_path(project_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="Project not found")
    return json.loads(path.read_text(encoding="utf-8"))


def write_project(project: dict[str, Any]) -> None:
    project["updated_at"] = datetime.now(timezone.utc).isoformat()
    path = metadata_path(project["id"])
    path.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")


def safe_filename(filename: str) -> str:
    name = unicodedata.normalize("NFC", Path(unquote(filename)).name.strip() or "audio")
    return re.sub(r"[^\w._ -]+", "_", name, flags=re.UNICODE)


def display_filename(filename: str | None) -> str | None:
    if not filename:
        return filename
    filename = unicodedata.normalize("NFC", filename)
    if re.search(r"_[0-9A-Fa-f]{2}", filename):
        decoded = unquote(re.sub(r"_([0-9A-Fa-f]{2})", r"%\1", filename))
        return decoded or filename
    return filename


def attachment_headers(filename: str) -> dict[str, str]:
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", filename) or "transcript.txt"
    return {"Content-Disposition": f"attachment; filename={ascii_name}; filename*=UTF-8''{quote(filename)}"}


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/projects")
async def list_projects() -> list[dict[str, Any]]:
    projects = []
    for path in sorted(DATA_DIR.glob("*/project.json"), reverse=True):
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        audio_path = path.parent / str(project.get("audio_path") or "")
        if not project.get("audio_path") or not audio_path.exists() or audio_path.stat().st_size < 100:
            continue
        projects.append(
            {
                "id": project["id"],
                "audio_filename": display_filename(project.get("audio_filename")),
                "transcript_filename": display_filename(project.get("transcript_filename")),
                "segment_count": len(project.get("segments", [])),
                "updated_at": project.get("updated_at"),
            }
        )
    return sorted(projects, key=lambda item: item.get("updated_at") or "", reverse=True)


@app.post("/api/projects")
async def create_project(payload: ProjectCreate) -> dict[str, Any]:
    try:
        segments = parse_transcript(payload.transcript_filename, payload.transcript_text)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not parse transcript: {exc}") from exc
    if not segments:
        raise HTTPException(status_code=400, detail="Transcript did not contain editable segments")

    project_id = uuid.uuid4().hex[:12]
    directory = DATA_DIR / project_id
    directory.mkdir(parents=True)

    project = {
        "id": project_id,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "audio_filename": safe_filename(payload.audio_filename),
        "audio_type": payload.audio_type or mimetypes.guess_type(payload.audio_filename)[0] or "audio/mpeg",
        "audio_path": None,
        "transcript_filename": safe_filename(payload.transcript_filename),
        "segments": renumber_segments(segments),
    }
    write_project(project)
    return project


@app.put("/api/projects/{project_id}/audio")
async def upload_audio(
    project_id: str,
    request: Request,
    x_filename: str | None = Header(default=None),
    content_type: str | None = Header(default=None),
) -> dict[str, Any]:
    directory = project_dir(project_id)
    project = read_project(project_id)
    filename = safe_filename(x_filename or project.get("audio_filename") or "audio")
    audio_dir = directory / "audio"
    audio_dir.mkdir(exist_ok=True)
    target = audio_dir / filename
    with target.open("wb") as buffer:
        async for chunk in request.stream():
            buffer.write(chunk)
    project["audio_filename"] = filename
    project["audio_type"] = content_type or project.get("audio_type") or "audio/mpeg"
    project["audio_path"] = str(target.relative_to(directory))
    write_project(project)
    return {"audio_url": f"/api/projects/{project_id}/audio", "project": project}


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str) -> dict[str, Any]:
    return read_project(project_id)


@app.patch("/api/projects/{project_id}")
async def update_project(project_id: str, payload: ProjectUpdate) -> dict[str, Any]:
    project = read_project(project_id)
    project["segments"] = renumber_segments(payload.segments)
    write_project(project)
    return project


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str) -> dict[str, str]:
    directory = project_dir(project_id)
    shutil.rmtree(directory)
    return {"status": "deleted"}


@app.get("/api/projects/{project_id}/audio")
async def get_audio(project_id: str) -> FileResponse:
    directory = project_dir(project_id)
    project = read_project(project_id)
    relative_path = project.get("audio_path")
    if not relative_path:
        raise HTTPException(status_code=404, detail="Audio has not been uploaded")
    path = directory / relative_path
    if not path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found")
    return FileResponse(
        path,
        media_type=project.get("audio_type") or "application/octet-stream",
        filename=project.get("audio_filename") or path.name,
    )


@app.get("/api/projects/{project_id}/export/{format_name}")
async def export_project(project_id: str, format_name: str):
    project = read_project(project_id)
    segments = project.get("segments", [])
    stem = Path(project.get("transcript_filename") or "transcript").stem
    if format_name == "srt":
        return PlainTextResponse(
            export_srt(segments),
            media_type="application/x-subrip",
            headers=attachment_headers(f"{stem}.edited.srt"),
        )
    if format_name == "vtt":
        return PlainTextResponse(
            export_vtt(segments),
            media_type="text/vtt",
            headers=attachment_headers(f"{stem}.edited.vtt"),
        )
    if format_name == "txt":
        return PlainTextResponse(
            export_txt(segments),
            media_type="text/plain",
            headers=attachment_headers(f"{stem}.edited.txt"),
        )
    if format_name == "csv":
        return PlainTextResponse(
            export_csv(segments),
            media_type="text/csv",
            headers=attachment_headers(f"{stem}.edited.csv"),
        )
    if format_name == "json":
        return JSONResponse(
            project,
            headers=attachment_headers(f"{stem}.edited.json"),
        )
    raise HTTPException(status_code=404, detail="Unsupported export format")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
