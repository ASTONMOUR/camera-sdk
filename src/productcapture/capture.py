"""Build the guide workflow for one package shape.

The overlay and the auto-capture state machine read ``build_plan`` so that both the
zero-build web SDK and the Next.js app agree on which surfaces to photograph and in
what order. A flat pack needs its two faces. A cylindrical pack is photographed in 90°
turns around the axis; the last foot/head surface is only required when the shape
actually has one, which for a bottle or can is the base ("see base of can" is a real
Legal Metrology instruction the compliance reader runs into).

Nothing in here touches a camera or a model. It is a pure map from a shape name to the
ordered list of surfaces, which is what makes it testable in one line and shareable
with the client verbatim.
"""

from __future__ import annotations

from productcapture.schemas import SLOT_SURFACE, SURFACE_SEQUENCES, PackShape, Slot, Surface


def surfaces_for_shape(shape: PackShape) -> tuple[Slot, ...]:
    """Return the ordered slot list a shape requires, in capture order."""
    return SURFACE_SEQUENCES.get(shape, SURFACE_SEQUENCES["flat"])


def surface_for_slot(slot: str) -> Surface:
    """Map a capture slot to the LabelCheck surface it adjudicates as.

    Two slots can share a surface — a cylinder's two sides are both ``side`` —
    which is exactly why the two vocabularies are kept apart.
    """
    return SLOT_SURFACE.get(slot, "unknown")


def build_plan(shape: PackShape) -> dict:
    """Return the capture plan for one shape.

    The plan is a plain dict so it serializes straight into ``SessionResponse`` and can
    be embedded in the page as JSON. ``steps`` is the ordered surface list, and
    ``between`` describes the instruction to show between successive steps — for a
    cylinder, that is the rotation the spec asks for.
    """
    steps = list(surfaces_for_shape(shape))
    between = _between_instruction(shape, steps)
    return {
        "shape": shape,
        "steps": steps,
        "total_steps": len(steps),
        "between": between,
    }


def _between_instruction(shape: PackShape, steps: list[Slot]) -> list[str]:
    """Return the prompt to show between each pair of consecutive slots."""
    if shape == "cylindrical":
        # A cylinder is shot around its axis: front, then a 90° turn, and so on.
        # The lid and the base are photographed by tilting rather than turning,
        # so they each get their own instruction.
        tilt = {
            "top": "Tilt the pack to photograph the lid.",
            "base": "Tilt the pack to photograph the base.",
        }
        return [
            tilt.get(steps[index + 1], "Rotate the pack 90° and continue.")
            for index in range(len(steps) - 1)
        ]
    return ["Turn the pack over to photograph the back."]
