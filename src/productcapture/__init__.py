"""ProductCapture — the AI-guided capture front half of LabelCheck.

This package turns a phone camera into a guided, bank-KYC-style product photography
tool. It produces clean, compliance-ready images of packaged food, then hands them to
LabelCheck's existing engine for OCR and Legal Metrology / FSSAI adjudication.

The one architectural rule of LabelCheck still holds: a vision layer transcribes and
measures, and never judges. Nothing in here decides whether a pack is compliant; the
verdict comes from :mod:`labelcheck.engine`, a pure function of a pack record.
"""

from __future__ import annotations

# LabelCheck lives in a separate checkout; make it importable before any module
# below reaches for labelcheck.engine or labelcheck.contract.
from productcapture._labelcheck_path import ensure_importable

ensure_importable()

from productcapture.capture import build_plan, SURFACE_SEQUENCES  # noqa: E402

__all__ = ["build_plan", "SURFACE_SEQUENCES"]
