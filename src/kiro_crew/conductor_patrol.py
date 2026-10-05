"""Server-side default patrol for a conductor that dispatched work.

A conductor hands an item to a worker with ``work_ledger_record action=bind``.
Its prompt tells it to arm a ``monitor_start`` loop on itself afterwards, but
nothing enforced that: a conductor that forgot left its workers reporting to a
ledger nobody read. Two pieces close the gap:

* :func:`ensure_patrol` -- called by the bind route after a bind commits. When
  the conductor's slot has NO loop at all, it arms a ``watch="work-ledger"``
  patrol through the same chokepoint an agent's own ``monitor_start`` uses
  (``autonudge_authz.authorize_and_add_nudge``), create-only, so an existing
  loop -- active, paused or stopped and retained by a person -- is never
  displaced or stacked. A refusal is logged at WARNING and never fails the bind.
* :func:`has_active_loop` -- read by ``work_ledger_read`` to flag each open item
  ``unpatrolled`` while the conductor has no active loop, so the next turn sees it.

Provenance: the bind request is the conductor session's own authenticated tool
call (internal secret plus the unforgeable ``X-Session-Key`` of the MCP peer),
so the arm names the conductor's own binding as ``initiator_slot_key``. The
authorizer -- not this module -- decides from the slot's mode whether that is a
crew/member self-arm and, if so, writes the keystone-gated trust record
(``autonudge_selfarm.record_self_arm``) itself. This module never sets
``self_armed``. The armed message is fixed text authored here, not agent input.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

#: Inside the conductor's 300..900 s band; with the two bounds below it passes
#: the goal-conductor skill's ``patrol_budget.py check`` (pinned by a test).
PATROL_INTERVAL_SECS = 600
PATROL_MAX_CYCLES = 300
PATROL_MAX_RUNTIME_SECS = 86400

PATROL_WATCH = "work-ledger"

PATROL_MESSAGE = (
    "Conductor patrol (armed by the gateway when you bound a worker and had no "
    "loop). Run work_ledger_read with compact=true. For each item with status "
    "done, read its bar with a full work_ledger_read, pipe the done-only "
    "accept_batch into the goal-conductor skill's accept_eval.py, and record the "
    "answer with work_ledger_record action=verdict. Answer question and blocked "
    "items with session_send. Ignore progress. Tune this loop with "
    "monitor_update; call autonudge_stop when every item is terminal or the user "
    "says stop."
)

#: Outcomes :func:`ensure_patrol` returns, surfaced on the bind reply as ``patrol``.
ARMED = "armed"
EXISTING = "existing"
REFUSED = "refused"
UNSUPPORTED = "unsupported"


def nudge_slot_for(state: Any, conductor_key: str) -> str | None:
    """The autonudge binding key of *conductor_key*, or ``None`` if none exists.

    The ledger key is the dashboard-prefix-stripped spelling, which for a
    dashboard session IS the bare slot key loops bind to; channel keys map
    through ``autonudge.binding_key_for``. Anything else (a ``cron:`` or
    ``subagent:`` key, a slot that is gone) has no loop to arm or read.
    """
    from kiro_crew.autonudge import binding_key_for

    key = (conductor_key or "").strip()
    if not key:
        return None
    channel = binding_key_for(key)
    if channel is not None:
        return channel
    try:
        return key if state.get_slot(key) is not None else None
    except Exception:  # noqa: BLE001 - a slot-table read must not fail the caller
        logger.debug("slot lookup failed for %s", key, exc_info=True)
        return None


def _loop_on(state: Any, conductor_key: str) -> tuple[Any, Any, str | None]:
    from kiro_crew.autonudge import get_instance

    svc = get_instance()
    slot = nudge_slot_for(state, conductor_key)
    if svc is None or slot is None:
        return svc, None, slot
    try:
        return svc, svc.get_by_slot(slot), slot
    except Exception:  # noqa: BLE001 - a store read must not fail the caller
        logger.debug("loop lookup failed for %s", slot, exc_info=True)
        return svc, None, slot


def has_active_loop(state: Any, conductor_key: str) -> bool:
    """Whether the conductor's slot holds an ACTIVE loop. Unreadable reads False."""
    _svc, loop, _slot = _loop_on(state, conductor_key)
    return bool(getattr(loop, "active", False)) if loop is not None else False


async def ensure_patrol(state: Any, conductor_key: str) -> str:
    """Arm the default patrol on the conductor's slot when it holds no loop.

    Never raises: every failure is logged and answered as an outcome string,
    because the bind that called this has already committed.
    """
    try:
        svc, loop, slot = _loop_on(state, conductor_key)
        if svc is None or slot is None:
            logger.warning(
                "conductor patrol not armed for %s: %s",
                conductor_key,
                "auto-nudge is disabled" if svc is None else "session cannot host a loop",
            )
            return UNSUPPORTED
        if loop is not None:
            # Any record -- active, approval-held, or stopped and retained -- is
            # left alone: a person's stop must not be revived by a later bind.
            return EXISTING
        from kiro_crew.autonudge import is_channel_key
        from kiro_crew.autonudge_authz import authorize_and_add_nudge
        from kiro_crew.monitoring.models import MonitorCreationSurface

        _armed, error, status = await authorize_and_add_nudge(
            svc=svc,
            state=state,
            slot_key=slot,
            message=PATROL_MESSAGE,
            idle_secs=PATROL_INTERVAL_SECS,
            max_cycles=PATROL_MAX_CYCLES,
            max_runtime_secs=PATROL_MAX_RUNTIME_SECS,
            watch=PATROL_WATCH,
            gate=True,
            source="work-ledger-bind",
            caller="conductor-patrol",
            # Create-only and no stopped-row displacement: a loop that appeared
            # since the read above wins, and nothing is ever stacked beside it.
            replace_existing=False,
            replace_stopped=False,
            initiator_slot_key=slot,
            creation_surface=(
                MonitorCreationSurface.CHANNEL
                if is_channel_key(slot)
                else MonitorCreationSurface.DASHBOARD
            ),
        )
    except Exception:  # noqa: BLE001 - the bind already committed
        logger.warning("conductor patrol arm failed for %s", conductor_key, exc_info=True)
        return REFUSED
    if error is not None:
        logger.warning(
            "conductor patrol arm refused for %s: %s [status %s]", conductor_key, error, status
        )
        return REFUSED
    logger.info("conductor patrol armed on %s", slot)
    return ARMED
