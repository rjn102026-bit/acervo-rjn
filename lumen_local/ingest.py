"""Ingestão local conservadora: inventariar, copiar, verificar e registrar."""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path


MEDIA_EXTENSIONS = {
    ".mp4", ".mov", ".mxf", ".avi", ".mts", ".m2ts", ".mpg", ".mpeg",
    ".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dng", ".heic", ".cr2", ".nef",
    ".srt", ".gpx", ".kml", ".csv",
}
CHUNK_SIZE = 4 * 1024 * 1024


def _safe_workspace(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise ValueError("O espaço deve conter 1–64 letras, números, hífen ou sublinhado.")
    return value


def _hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(CHUNK_SIZE), b""):
            digest.update(block)
    return digest.hexdigest()


def _inside(child: Path, parent: Path) -> bool:
    return child == parent or parent in child.parents


def ingest_capture(source: str | Path, destination: str | Path, workspace: str, capture: str) -> dict:
    """Copy supported files without modifying source; verify each copied byte stream.

    Destination must be outside source and source outside destination, preventing
    recursive scans and accidental ingestion from the permanent archive.
    """
    workspace = _safe_workspace(workspace)
    if not capture.strip():
        raise ValueError("Informe o nome da captação.")

    source_path = Path(source).expanduser().resolve()
    destination_path = Path(destination).expanduser().resolve()
    if not source_path.is_dir() or Path(source).is_symlink():
        raise ValueError("A origem precisa ser uma pasta existente.")
    if _inside(destination_path, source_path) or _inside(source_path, destination_path):
        raise ValueError("Origem e destino devem ser pastas separadas, sem uma dentro da outra.")

    files = sorted(
        (path for path in source_path.rglob("*") if path.is_file() and not path.is_symlink()
         and path.suffix.lower() in MEDIA_EXTENSIONS),
        key=lambda path: str(path.relative_to(source_path)).lower(),
    )
    if not files:
        raise ValueError("Nenhuma mídia suportada encontrada na origem.")

    capture_id = str(uuid.uuid4())
    capture_dir = destination_path / "workspaces" / workspace / "captures" / capture_id
    originals_dir = capture_dir / "originals"
    originals_dir.mkdir(parents=True, exist_ok=False)
    entries = []
    for path in files:
        asset_id = str(uuid.uuid4())
        copied = originals_dir / f"{asset_id}{path.suffix.lower()}"
        partial = originals_dir / f"{asset_id}.partial"
        entry = {
            "asset_id": asset_id,
            "original_name": path.name,
            "original_relative_path": str(path.relative_to(source_path)),
            "copy_relative_path": str(copied.relative_to(capture_dir)),
            "status": "copying",
        }
        entries.append(entry)
        try:
            source_size_before = path.stat().st_size
            source_hash = hashlib.sha256()
            with path.open("rb") as reader, partial.open("xb") as writer:
                for block in iter(lambda: reader.read(CHUNK_SIZE), b""):
                    source_hash.update(block)
                    writer.write(block)
                writer.flush()
                os.fsync(writer.fileno())
            if path.stat().st_size != source_size_before:
                raise IOError("Tamanho da origem mudou durante a cópia")
            if partial.stat().st_size != source_size_before or _hash_file(partial) != source_hash.hexdigest():
                raise IOError("A cópia não passou na verificação de tamanho e hash")
            os.replace(partial, copied)
            entry.update(status="verified", size_bytes=source_size_before, sha256=source_hash.hexdigest())
        except (OSError, IOError) as exc:
            partial.unlink(missing_ok=True)
            entry.update(status="failed", error=str(exc))

    manifest = {
        "schema_version": 1,
        "capture_id": capture_id,
        "workspace_id": workspace,
        "capture_name": capture.strip(),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_path": str(source_path),
        "assets": entries,
        "verified_count": sum(entry["status"] == "verified" for entry in entries),
        "failed_count": sum(entry["status"] == "failed" for entry in entries),
        "warning": "A verificação da cópia não substitui um segundo backup. Não formate o cartão apenas com base neste manifesto.",
    }
    manifest_path = capture_dir / "manifest.json"
    temporary_manifest = capture_dir / "manifest.json.partial"
    with temporary_manifest.open("x", encoding="utf-8") as stream:
        json.dump(manifest, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary_manifest, manifest_path)
    manifest["manifest_path"] = str(manifest_path)
    return manifest
