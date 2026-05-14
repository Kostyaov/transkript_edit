from __future__ import annotations

import html
import csv
import io
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


TIMECODE_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})\s*-->\s*"
    r"(?P<end>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3})"
)
SPEAKER_RANGE_RE = re.compile(
    r"^\[(?P<speaker>[^\]]+)\]\s*"
    r"\((?P<start>\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\s*[-–—]\s*"
    r"(?P<end>\d{1,2}:\d{2}(?::\d{2})?(?:[,.]\d{1,3})?)\)\s*$"
)
TAG_RE = re.compile(r"<[^>]+>")


@dataclass
class Segment:
    id: int
    start: float
    end: float
    text: str
    speaker: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "start": round(max(0.0, self.start), 3),
            "end": round(max(0.0, self.end), 3),
            "speaker": self.speaker.strip(),
            "text": self.text.strip(),
        }


def seconds_from_timecode(value: str) -> float:
    clean = value.strip().replace(",", ".")
    parts = clean.split(":")
    if len(parts) == 2:
        minutes, seconds = parts
        return int(minutes) * 60 + float(seconds)
    if len(parts) == 3:
        hours, minutes, seconds = parts
        return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
    raise ValueError(f"Unsupported timecode: {value}")


def srt_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int(round((seconds - int(seconds)) * 1000))
    if millis == 1000:
        secs += 1
        millis = 0
    if secs == 60:
        minutes += 1
        secs = 0
    if minutes == 60:
        hours += 1
        minutes = 0
    return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"


def vtt_time(seconds: float) -> str:
    return srt_time(seconds).replace(",", ".")


def clean_text(text: str) -> str:
    unescaped = html.unescape(text)
    return TAG_RE.sub("", unescaped).strip()


def parse_transcript(filename: str, content: str) -> list[dict[str, Any]]:
    suffix = Path(filename).suffix.lower()
    if suffix == ".json":
        return parse_json(content)
    if suffix == ".csv":
        return parse_csv(content)
    if suffix == ".vtt":
        return parse_vtt(content)
    if suffix == ".srt":
        return parse_srt(content)
    return parse_plain_text(content)


def parse_csv(content: str) -> list[dict[str, Any]]:
    reader = csv.DictReader(io.StringIO(normalize_newlines(content).lstrip("\ufeff")))
    if not reader.fieldnames:
        return []
    fields = {field.strip().lower(): field for field in reader.fieldnames if field}
    required = {"start", "end", "text"}
    if not required.issubset(fields):
        raise ValueError("CSV must contain start, end and text columns")

    raw_segments: list[dict[str, Any]] = []
    for row in reader:
        text = str(row.get(fields["text"], "")).strip()
        if not text:
            continue
        start = parse_csv_time(row.get(fields["start"], "0"))
        end = parse_csv_time(row.get(fields["end"], start))
        raw_segments.append(
            {
                "id": len(raw_segments) + 1,
                "start": start,
                "end": end,
                "speaker": str(row.get(fields.get("speaker", ""), "")).strip() if "speaker" in fields else "",
                "text": clean_text(text),
            }
        )
    return renumber_segments(raw_segments)


def parse_csv_time(value: Any) -> float:
    if value is None:
        return 0.0
    clean = str(value).strip()
    if not clean:
        return 0.0
    if ":" in clean:
        return seconds_from_timecode(clean)
    numeric = float(clean.replace(",", "."))
    # TurboScribe CSV exports millisecond offsets, e.g. 1690 == 1.69s.
    if abs(numeric) >= 100:
        return round(numeric / 1000, 3)
    return round(numeric, 3)


def parse_speaker_text(content: str) -> list[dict[str, Any]]:
    lines = normalize_newlines(content).splitlines()
    segments: list[Segment] = []
    current: dict[str, Any] | None = None
    text_lines: list[str] = []

    def flush_current() -> None:
        nonlocal current, text_lines
        if current is None:
            text_lines = []
            return
        text = "\n".join(text_lines).strip()
        if text:
            segments.append(
                Segment(
                    id=len(segments) + 1,
                    start=current["start"],
                    end=current["end"],
                    speaker=current["speaker"],
                    text=clean_text(text),
                )
            )
        current = None
        text_lines = []

    for line in lines:
        stripped = line.strip("\ufeff").strip()
        match = SPEAKER_RANGE_RE.match(stripped)
        if match:
            flush_current()
            current = {
                "speaker": match.group("speaker").strip(),
                "start": seconds_from_timecode(match.group("start")),
                "end": seconds_from_timecode(match.group("end")),
            }
            continue
        if current is None:
            continue
        text_lines.append(line.rstrip())

    flush_current()
    return [segment.as_dict() for segment in segments]


def parse_srt(content: str) -> list[dict[str, Any]]:
    blocks = re.split(r"\n\s*\n", normalize_newlines(content).strip())
    segments: list[Segment] = []
    for block in blocks:
        lines = [line.strip("\ufeff") for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        time_line_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if time_line_index is None:
            continue
        match = TIMECODE_RE.search(lines[time_line_index])
        if not match:
            continue
        text = "\n".join(lines[time_line_index + 1 :]).strip()
        if not text:
            continue
        segments.append(
            Segment(
                id=len(segments) + 1,
                start=seconds_from_timecode(match.group("start")),
                end=seconds_from_timecode(match.group("end")),
                speaker="",
                text=clean_text(text),
            )
        )
    return [segment.as_dict() for segment in segments]


def parse_vtt(content: str) -> list[dict[str, Any]]:
    normalized = normalize_newlines(content).strip()
    normalized = re.sub(r"^\ufeff?WEBVTT[^\n]*\n+", "", normalized, flags=re.IGNORECASE)
    blocks = re.split(r"\n\s*\n", normalized)
    segments: list[Segment] = []
    for block in blocks:
        lines = [line.strip("\ufeff") for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        if lines[0].upper().startswith(("NOTE", "STYLE", "REGION")):
            continue
        time_line_index = next((i for i, line in enumerate(lines) if "-->" in line), None)
        if time_line_index is None:
            continue
        match = TIMECODE_RE.search(lines[time_line_index])
        if not match:
            continue
        text = "\n".join(lines[time_line_index + 1 :]).strip()
        if not text:
            continue
        segments.append(
            Segment(
                id=len(segments) + 1,
                start=seconds_from_timecode(match.group("start")),
                end=seconds_from_timecode(match.group("end")),
                speaker="",
                text=clean_text(text),
            )
        )
    return [segment.as_dict() for segment in segments]


def parse_json(content: str) -> list[dict[str, Any]]:
    payload = json.loads(content)
    raw_segments = payload.get("segments") if isinstance(payload, dict) else payload
    if not isinstance(raw_segments, list):
        raise ValueError("JSON must contain a segments array")

    segments: list[dict[str, Any]] = []
    for index, item in enumerate(raw_segments, start=1):
        if not isinstance(item, dict):
            continue
        text = str(item.get("text", "")).strip()
        if not text:
            continue
        segments.append(
            {
                "id": int(item.get("id") or index),
                "start": round(float(item.get("start") or 0), 3),
                "end": round(float(item.get("end") or item.get("start") or 0), 3),
                "speaker": str(item.get("speaker") or "").strip(),
                "text": text,
            }
        )
    return renumber_segments(segments)


def parse_plain_text(content: str) -> list[dict[str, Any]]:
    speaker_segments = parse_speaker_text(content)
    if speaker_segments:
        return speaker_segments

    paragraphs = [
        paragraph.strip()
        for paragraph in re.split(r"\n\s*\n", normalize_newlines(content))
        if paragraph.strip()
    ]
    if not paragraphs:
        paragraphs = [line.strip() for line in normalize_newlines(content).splitlines() if line.strip()]
    segments = []
    cursor = 0.0
    for index, paragraph in enumerate(paragraphs, start=1):
        duration = max(2.0, min(12.0, len(paragraph.split()) * 0.45))
        segments.append(
            {
                "id": index,
                "start": round(cursor, 3),
                "end": round(cursor + duration, 3),
                "speaker": "",
                "text": paragraph,
            }
        )
        cursor += duration
    return segments


def normalize_newlines(content: str) -> str:
    return content.replace("\r\n", "\n").replace("\r", "\n")


def renumber_segments(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for index, item in enumerate(segments, start=1):
        start = round(max(0.0, float(item.get("start", 0))), 3)
        end = round(max(start, float(item.get("end", start))), 3)
        normalized.append(
            {
                "id": index,
                "start": start,
                "end": end,
                "speaker": str(item.get("speaker", "")).strip(),
                "text": str(item.get("text", "")).strip(),
            }
        )
    return normalized


def export_srt(segments: list[dict[str, Any]]) -> str:
    blocks = []
    for index, segment in enumerate(renumber_segments(segments), start=1):
        text = segment["text"]
        if segment.get("speaker"):
            text = f"{segment['speaker']}: {text}"
        blocks.append(
            "\n".join(
                [
                    str(index),
                    f"{srt_time(segment['start'])} --> {srt_time(segment['end'])}",
                    text,
                ]
            )
        )
    return "\n\n".join(blocks) + "\n"


def export_vtt(segments: list[dict[str, Any]]) -> str:
    blocks = ["WEBVTT", ""]
    for segment in renumber_segments(segments):
        blocks.append(f"{vtt_time(segment['start'])} --> {vtt_time(segment['end'])}")
        text = segment["text"]
        if segment.get("speaker"):
            text = f"<v {segment['speaker']}>{text}"
        blocks.append(text)
        blocks.append("")
    return "\n".join(blocks)


def export_txt(segments: list[dict[str, Any]]) -> str:
    blocks = []
    current_speaker: str | None = None
    current_lines: list[str] = []

    def flush_block() -> None:
        nonlocal current_speaker, current_lines
        if current_speaker is None:
            return
        blocks.append("\n".join([f"[{current_speaker}]", *current_lines]))
        current_speaker = None
        current_lines = []

    for segment in renumber_segments(segments):
        speaker = segment.get("speaker") or "Мовець"
        if speaker != current_speaker:
            flush_block()
            current_speaker = speaker
        text = finalize_sentence(segment["text"])
        if text:
            current_lines.append(text)

    flush_block()
    return "\n\n".join(blocks) + "\n"


def finalize_sentence(text: str) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    clean = re.sub(r"\s+([,.!?;:])", r"\1", clean)
    if clean and clean[-1] not in ".!?…:;":
        clean += "."
    return clean


def export_csv(segments: list[dict[str, Any]]) -> str:
    buffer = io.StringIO()
    writer = csv.DictWriter(buffer, fieldnames=["start", "end", "text", "speaker"], quoting=csv.QUOTE_ALL)
    writer.writeheader()
    for segment in renumber_segments(segments):
        writer.writerow(
            {
                "start": int(round(segment["start"] * 1000)),
                "end": int(round(segment["end"] * 1000)),
                "text": segment["text"],
                "speaker": segment.get("speaker", ""),
            }
        )
    return buffer.getvalue()


def compact_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    if hours:
        return f"{hours}:{minutes:02}:{secs:02}"
    return f"{minutes}:{secs:02}"
