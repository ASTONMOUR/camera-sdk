"""Locate the LabelCheck source tree so ``import labelcheck`` resolves.

ProductCapture is the capture half; LabelCheck is the compliance half. They are
separate checkouts, and LabelCheck is not published to an index we can install
from here, so this module puts its ``src`` directory on ``sys.path`` at import
time. That keeps one source of truth for the rule table and the data contract
instead of vendoring a copy that would silently drift out of date.

Resolution order:

1. ``$LABELCHECK_SRC`` — an explicit path to LabelCheck's ``src`` directory.
2. A sibling ``sih26034/src`` checkout beside this repository.
3. Nothing — ``labelcheck`` is assumed already importable (installed, or on
   ``PYTHONPATH``), and this module stays out of the way.

If none of those resolve, the ImportError raised later names this module and
says what to set, rather than surfacing a bare "No module named labelcheck".
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# A sibling checkout is the layout on a dev machine: both repos under one
# parent. Add more names here if the compliance repo is cloned under another.
SIBLING_CANDIDATES: tuple[str, ...] = ("sih26034", "labelcheck")

ENV_VAR = "LABELCHECK_SRC"


def _candidates() -> list[Path]:
    """Return every path worth trying, in priority order."""
    found: list[Path] = []
    override = os.environ.get(ENV_VAR)
    if override:
        found.append(Path(override).expanduser())

    # This file is <repo>/src/productcapture/_labelcheck_path.py, so the repo
    # root is three parents up and its siblings are four up.
    repo_root = Path(__file__).resolve().parent.parent.parent
    for name in SIBLING_CANDIDATES:
        found.append(repo_root.parent / name / "src")
    return found


def ensure_importable() -> Path | None:
    """Put the LabelCheck ``src`` directory on ``sys.path``; return what was used.

    Returns ``None`` when ``labelcheck`` is already importable, which is the case
    when it has been pip-installed or is already on ``PYTHONPATH``.
    """
    try:
        import labelcheck  # noqa: F401
        return None
    except ImportError:
        pass

    for candidate in _candidates():
        if (candidate / "labelcheck" / "__init__.py").is_file():
            resolved = str(candidate)
            if resolved not in sys.path:
                sys.path.insert(0, resolved)
            return candidate

    raise ImportError(
        "ProductCapture needs the LabelCheck compliance engine, which is not "
        f"importable and was not found beside this repository. Set {ENV_VAR} to "
        "LabelCheck's 'src' directory, e.g.\n"
        f"    export {ENV_VAR}=~/Downloads/sih26034/src\n"
        f"Looked in: {', '.join(str(one) for one in _candidates())}"
    )
