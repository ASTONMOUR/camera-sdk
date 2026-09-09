"""Bridge: run OCR over stored surfaces, merge them, adjudicate the pack.

This module sits between the OCR layer and the LabelCheck engine. It never
adjudicates directly — it assembles the surface records the OCR layer produced,
hands them to ``labelcheck.merge.merge_surfaces``, and passes the merged pack
to ``labelcheck.engine.evaluate``. Every verdict comes out of that engine.

The one thing added here is the mapping from the engine's internal Verdict and
Advisory objects into the plain dicts the HTTP response carries. The engine is
the authority on what those objects mean; this module just serialises them.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from labelcheck.engine import evaluate, load_rules, summary, worst
from labelcheck.merge import merge_surfaces

from productcapture.capture import surface_for_slot
from productcapture.ocr import active_backend, extract_surface


def run(
    session_dir: Path,
    surfaces: list[str],
    pack_shape: str = "unknown",
    today: date | None = None,
) -> dict:
    """OCR all captured slots in session_dir that have not been cached, then adjudicate.

    ``surfaces`` is the ordered list of capture *slots* the session stored, e.g.
    ``["front", "back"]`` or ``["front", "side_1", "back", "side_2", "top", "base"]``.
    The function reads the stored JPEG for each one, calls ``extract_surface``
    (which caches its result beside the image, keyed on the slot), merges all
    surface records, and runs the rule engine.

    Returns a dict shaped exactly like ``ComplianceResponse`` minus ``session_id``
    and ``shape``, which the caller fills in.
    """
    surface_records: list[dict] = []
    backend = active_backend()

    for slot in surfaces:
        cache = session_dir / f"{slot}.json"
        if cache.exists():
            import json
            record = json.loads(cache.read_text(encoding="utf-8"))
        else:
            jpg = session_dir / f"{slot}.jpg"
            if not jpg.exists():
                # Slot was listed but never written; leave it out — the merge
                # will leave its fields null and the engine will report INCOMPLETE.
                continue
            import cv2
            image = cv2.imread(str(jpg))
            if image is None:
                continue
            record = extract_surface(
                image,
                surface=surface_for_slot(slot),
                pack_shape=pack_shape,
                session_dir=session_dir,
                slot=slot,
            )
        surface_records.append(record)

    pack = merge_surfaces(surface_records)
    table = load_rules()
    verdicts, advisories = evaluate(pack, today=today, table=table)

    counts = summary(verdicts)
    worst_state = worst(verdicts)

    # Pull image quality from the merged pack (worst across surfaces).
    image_quality = pack.get("image_quality") or {}

    # Surface fields: lift each field into the MetadataField wire shape.
    fields_out: dict[str, dict] = {}
    for field_name, entry in (pack.get("fields") or {}).items():
        if isinstance(entry, dict):
            fields_out[field_name] = {
                "value": entry.get("value"),
                "confidence": float(entry.get("confidence") or 0.0),
                "as_printed": entry.get("as_printed"),
            }
        else:
            fields_out[field_name] = {"value": None, "confidence": 0.0, "as_printed": None}

    return {
        "surfaces_captured": list(pack.get("surfaces_seen") or []),
        "worst": worst_state.value,
        "summary": counts,
        "fields": fields_out,
        "nutrition": dict(pack.get("nutrition") or {}),
        "ingredients_raw": pack.get("ingredients_raw"),
        "verdicts": [v.as_dict() for v in verdicts],
        "advisories": [a.as_dict() for a in advisories],
        "ocr_backend": backend,
        "image_quality": {k: v for k, v in image_quality.items()
                          if isinstance(v, (int, float, bool))},
    }
