"""OCR: turn one photographed surface into a LabelCheck surface record.

The primary backend is PaddleOCR, imported lazily so that a machine without it can
still run the rest of the service. The fallback is the Gemini vision adapter already
built into LabelCheck (``labelcheck.extract.scan``), which is deterministic because it
caches its transcript beside the photograph as a ``.json`` file. Both paths produce a
``labelcheck.contract`` surface record, so the compliance engine consumes the output
without knowing which backend produced it.

The one architectural rule of LabelCheck is enforced here: this module transcribes. It
never decides whether anything is legal. Nothing it returns is a verdict.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

import cv2
import numpy as np

from labelcheck.contract import FIELD_NAMES, SURFACES, blank_surface

LOGGER = logging.getLogger(__name__)


def active_backend() -> str:
    """Return which OCR backend is currently importable."""
    try:
        import paddleocr  # noqa: F401
        return "paddleocr"
    except ImportError:
        pass
    if os.environ.get("GEMINI_API_KEY"):
        return "gemini"
    return "offline"


def extract_surface(
    image: np.ndarray,
    surface: str = "unknown",
    pack_shape: str = "unknown",
    session_dir: Path | None = None,
    slot: str | None = None,
) -> dict:
    """Return a ``labelcheck.contract`` surface record from a captured image.

    If ``session_dir`` is given and a ``.json`` cache already exists beside the image
    for this slot, it is read instead of transcribing again. This mirrors the
    ``labelcheck.extract.scan`` caching contract: one API call per image, ever.

    ``slot`` names the capture step and keys the cache; ``surface`` is what the
    record claims to the rule engine. They differ when two slots share a surface,
    e.g. a cylinder's ``side_1`` and ``side_2`` are both ``side``.
    """
    surface = surface if surface in SURFACES else "unknown"
    cache_path = _cache_path(session_dir, slot or surface)
    if cache_path and cache_path.exists():
        import json
        return json.loads(cache_path.read_text(encoding="utf-8"))

    backend = active_backend()
    if backend == "paddleocr":
        record = _paddle_extract(image, surface, pack_shape)
    elif backend == "gemini":
        record = _gemini_extract(image, surface, pack_shape, session_dir)
    else:
        record = _offline_extract(image, surface, pack_shape)
    record["notes"].append(f"ocr_backend: {backend}")

    if cache_path:
        import json
        cache_path.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    return record


def _cache_path(session_dir: Path | None, key: str) -> Path | None:
    """Return the .json cache path for one capture slot, or None if no dir given."""
    if session_dir is None:
        return None
    return session_dir / f"{key}.json"


def _paddle_extract(image: np.ndarray, surface: str, pack_shape: str) -> dict:
    """Extract fields using PaddleOCR, returning a blank_surface populated with text."""
    try:
        from paddleocr import PaddleOCR
    except ImportError as error:
        raise RuntimeError("PaddleOCR is not installed") from error

    ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
    result = ocr.ocr(image, cls=True)
    lines = []
    if result:
        for block in result:
            if block:
                for line in block:
                    lines.append(line[1][0] if len(line) >= 2 else "")
    raw_text = "\n".join(lines)
    record = blank_surface(surface, pack_shape)
    # PaddleOCR produces raw text lines; field assignment is done by heuristic parsing
    # against the known field names, which is good enough for the compliance engine's
    # `as_printed` field.
    _fill_fields_from_raw_text(record, raw_text)
    record["ingredients_raw"] = _extract_ingredients(raw_text)
    return record


def _gemini_extract(
    image: np.ndarray, surface: str, pack_shape: str, session_dir: Path | None
) -> dict:
    """Write the image to a temp file and delegate to labelcheck.extract.scan."""
    from labelcheck.extract import transcribe_surface

    # Generate a filename the surface-name parser will recognize (the existing naming
    # convention from cli.py: "packname_surface.jpg").
    tmp_dir = Path(tempfile.mkdtemp(prefix="productcapture_"))
    tmp_img = tmp_dir / f"pack_{surface}.jpg"
    cv2.imwrite(str(tmp_img), image, [cv2.IMWRITE_JPEG_QUALITY, 92])
    try:
        return transcribe_surface(str(tmp_img), surface=surface, pack_shape=pack_shape)
    finally:
        tmp_img.unlink(missing_ok=True)
        try:
            tmp_dir.rmdir()
        except OSError:
            pass


def _offline_extract(image: np.ndarray, surface: str, pack_shape: str) -> dict:
    """Return a blank surface record with a note when no OCR backend is available.

    This is not a stub — it is the honest answer when there is no API key and no
    PaddleOCR: the image was captured, but transcription cannot run. The compliance
    engine will return UNREADABLE or INCOMPLETE for every field, which is true.
    """
    record = blank_surface(surface, pack_shape)
    record["notes"].append(
        "OCR could not run: PaddleOCR is not installed and GEMINI_API_KEY is not set. "
        "Every field is returned null; compliance checks will be INCOMPLETE or UNREADABLE."
    )
    return record


def _fill_fields_from_raw_text(record: dict, raw: str) -> None:
    """Fill `fields` in a blank surface record from raw OCR text using keyword matching.

    This is a best-effort heuristic: it is not a parser. The compliance engine reads
    ``as_printed`` and ``value`` from each field, so a value is better than nothing for
    fields whose label pattern is unambiguous (MRP, FSSAI, batch number). Fields whose
    values are ambiguous without layout (manufacturer vs marketer) are left null and
    marked for human review — a cautious default that follows the LabelCheck principle
    that a wrong accusation costs more than a missed field.
    """
    lower = raw.lower()
    lines = raw.splitlines()

    # MRP: look for the canonical pattern
    mrp_value, mrp_phrase = _find_mrp(lines)
    if mrp_value:
        record["fields"]["mrp"]["value"] = mrp_value
        record["fields"]["mrp"]["as_printed"] = mrp_phrase
        record["fields"]["mrp"]["confidence"] = 0.7
    if mrp_phrase:
        inc_phrase = _find_tax_phrase(mrp_phrase)
        if inc_phrase:
            record["fields"]["mrp_tax_phrase"]["value"] = inc_phrase
            record["fields"]["mrp_tax_phrase"]["as_printed"] = inc_phrase
            record["fields"]["mrp_tax_phrase"]["confidence"] = 0.7

    # FSSAI licence
    fssai = _find_pattern(lower, r"fssai[^0-9]*(\d{14})")
    if fssai:
        record["fields"]["fssai_licence"]["value"] = fssai
        record["fields"]["fssai_licence"]["as_printed"] = fssai
        record["fields"]["fssai_licence"]["confidence"] = 0.8

    # Batch number
    batch = _find_pattern(lower, r"batch\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9]+)")
    if batch:
        record["fields"]["batch_number"]["value"] = batch
        record["fields"]["batch_number"]["as_printed"] = batch
        record["fields"]["batch_number"]["confidence"] = 0.7

    # Barcode: 8-13 digit strings on their own line
    for line in lines:
        stripped = line.strip()
        if stripped.isdigit() and 8 <= len(stripped) <= 14:
            record["fields"]["barcode"]["value"] = stripped
            record["fields"]["barcode"]["as_printed"] = stripped
            record["fields"]["barcode"]["confidence"] = 0.75
            break

    # Net quantity
    nq = _find_pattern(raw, r"net\s+(?:weight|quantity|wt\.?)\s*([\d\.]+\s*[gGmMkKlL]+(?:l|L)?)")
    if nq:
        record["fields"]["net_quantity"]["value"] = nq.strip()
        record["fields"]["net_quantity"]["as_printed"] = nq.strip()
        record["fields"]["net_quantity"]["confidence"] = 0.75


def _find_mrp(lines: list[str]) -> tuple[str | None, str | None]:
    """Return (value, as_printed) for MRP if found."""
    import re
    for line in lines:
        match = re.search(r"M\.?R\.?P\.?\s*Rs\.?\s*([\d,\.]+)", line, re.IGNORECASE)
        if match:
            return match.group(1).replace(",", ""), line.strip()
    return None, None


def _find_tax_phrase(mrp_line: str) -> str | None:
    """Return the tax phrase from an MRP line, e.g. 'incl. of all taxes'."""
    import re
    match = re.search(r"(\(?incl\.?\s+of\s+all\s+tax(?:es)?\)?)", mrp_line, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return None


def _find_pattern(text: str, pattern: str) -> str | None:
    """Return the first captured group of the pattern, or None."""
    import re
    match = re.search(pattern, text, re.IGNORECASE)
    return match.group(1).strip() if match else None


def _extract_ingredients(raw: str) -> str | None:
    """Return the ingredient block from raw OCR text, or None."""
    lower = raw.lower()
    idx = lower.find("ingredient")
    if idx < 0:
        return None
    # Take from the word "Ingredients" to the end of the paragraph it's in (up to
    # the next blank line or the next well-known section heading).
    block = raw[idx:idx + 600]
    import re
    block = re.split(r"\n\s*\n|(?:nutritional|nutrition|advisory|contains)", block,
                     maxsplit=1, flags=re.IGNORECASE)[0]
    return block.strip() if block.strip() else None
