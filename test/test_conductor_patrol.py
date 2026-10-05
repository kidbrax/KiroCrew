"""A conductor's bind arms a default work-ledger patrol when it has no loop.

Pins the four behaviours ``conductor_patrol`` exists for:

* the first bind on a loop-less conductor arms ONE ``watch="work-ledger"`` loop,
  through the real authorizer, and a crew/member slot's arm writes the self-arm
  trust record through the authorizer's own path;
* a slot that already holds a loop -- active or stopped and retained -- is left
  alone, so a second bind never stacks a second loop;
* a refused arm is logged at WARNING and the bind still succeeds;
* ``work_ledger_read`` flags each OPEN item ``unpatrolled`` while the conductor
  holds no active loop.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from skill_script_helpers import load_skill_script

from kiro_crew import autonudge, autonudge_authz, conductor_patrol
from kiro_crew import work_ledger as wl
from kiro_crew.dashboard.handlers import work_ledger as routes

CONDUCTOR = "chat-p-conductor"
WORKER = "chat-p-worker"
WORKER_2 = "chat-p-worker-2"

PATROL_BUDGET = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "kiro_crew"
    / "builtin_skills"
    / "goal-conductor"
    / "scripts"
    / "patrol_budget.py"
)


class _Svc:
    """A loop store holding at most one loop per slot, as the real one does."""

    def __init__(self) -> None:
        self.loops: dict[str, Any] = {}
        self.added: list[dict[str, Any]] = []

    def get_by_slot(self, slot_key: str) -> Any:
        return self.loops.get(slot_key)

    def get_by_id(self, loop_id: str) -> Any:
        return next((lp for lp in self.loops.values() if lp.id == loop_id), None)

    async def add(self, **kw: Any) -> Any:
        if kw["slot_key"] in self.loops and kw.get("replace_existing") is False:
            raise autonudge.MonitorUpdateConflict("session already has an automation")
        self.added.append(kw)
        loop = SimpleNamespace(
            id=kw.get("loop_id") or f"loop-{len(self.added)}",
            slot_key=kw["slot_key"],
            idle_secs=kw["idle_secs"],
            max_cycles=kw["max_cycles"],
            monitor=None,
            gate=kw.get("gate", False),
            active=True,
        )
        self.loops[kw["slot_key"]] = loop
        return loop


class _Slot:
    def __init__(self, *, mode: str = "", memory_mode: str = "persistent", created_by: str = ""):
        self.mode = mode
        self.memory_mode = memory_mode
        self.workspace = "default"
        self._created_by = created_by
        self.running = False
        self.is_closing = False


_SLOTS: dict[str, _Slot] = {}


@pytest.fixture(autouse=True)
def _env(tmp_path, monkeypatch):
    monkeypatch.setenv("KIROCREW_HOME", str(tmp_path / "home"))
    _SLOTS.clear()

    async def _recognized(*a: Any, **k: Any) -> None:
        return None

    monkeypatch.setattr(routes, "_recognize_session", _recognized)
    monkeypatch.setattr(routes, "_is_restricted_session", lambda *a: False)
    monkeypatch.setattr(routes, "_reaches_a_channel", lambda request, sk: False)
    monkeypatch.setattr(routes.crew_log_emit, "enabled", lambda: True)
    monkeypatch.setattr(routes, "unit_for_session_key", lambda sessions, key: f"unit:{key}")
    monkeypatch.setattr(routes.crew_log_emit, "on_work_recorded", lambda unit, data: True)
    yield
    _SLOTS.clear()


@pytest.fixture
def svc(monkeypatch) -> _Svc:
    store = _Svc()
    monkeypatch.setattr(autonudge, "get_instance", lambda: store)
    return store


@pytest.fixture
def audits(monkeypatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    monkeypatch.setattr(
        autonudge_authz,
        "sel",
        lambda: SimpleNamespace(log_tool_invocation=lambda **kw: events.append(kw)),
    )
    return events


@pytest.fixture
def trust_record(monkeypatch) -> list[tuple[str, str]]:
    writes: list[tuple[str, str]] = []
    monkeypatch.setattr(
        autonudge_authz, "record_self_arm", lambda loop_id, slot: writes.append((loop_id, slot))
    )
    return writes


def _state() -> SimpleNamespace:
    return SimpleNamespace(
        _slots=_SLOTS,
        get_slot=lambda key: _SLOTS.get(key),
        sessions=MagicMock(),
        channel_transports={},
    )


def _req(method: str, path: str, *, body: Any = ..., sk: str) -> web.Request:
    app = web.Application()
    app["state"] = _state()
    req = make_mocked_request(method, path, app=app, headers={"X-Session-Key": sk})
    req["internal_auth"] = True
    if body is not ...:
        req.json = AsyncMock(return_value=body)  # type: ignore[method-assign]
    return req


async def _record(body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    resp = await routes.api_work_ledger_record(
        _req("POST", "/api/work-ledger/record", body=body, sk=CONDUCTOR)
    )
    return resp.status, json.loads(resp.text)


async def _read() -> dict[str, Any]:
    resp = await routes.api_work_ledger_get(
        _req("GET", "/api/work-ledger?compact=true", sk=CONDUCTOR)
    )
    assert resp.status == 200, resp.text
    return json.loads(resp.text)


async def _create(title: str) -> str:
    status, body = await _record(
        {"action": "create", "title": title, "acceptance": {"kind": "human_approval"}}
    )
    assert status == 200, body
    return body["item"]["item_id"]


async def _bind(item_id: str, worker: str) -> dict[str, Any]:
    _SLOTS[worker] = _Slot(created_by=CONDUCTOR)
    status, body = await _record(
        {"action": "bind", "item_id": item_id, "worker_session_key": worker}
    )
    assert status == 200, body
    return body


async def _setup(mode: str = "", memory_mode: str = "persistent") -> str:
    _SLOTS[CONDUCTOR] = _Slot(mode=mode, memory_mode=memory_mode)
    status, body = await _record({"action": "goal", "goal": "drive the fleet", "round": 1})
    assert status == 200, body
    return await _create("item one")


# ── arm on first bind ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_first_bind_arms_one_work_ledger_patrol(svc, audits):
    item_id = await _setup()
    body = await _bind(item_id, WORKER)

    assert body["patrol"] == conductor_patrol.ARMED
    assert len(svc.added) == 1
    armed = svc.added[0]
    assert armed["slot_key"] == CONDUCTOR
    assert armed["watch"] == "work-ledger"
    assert armed["gate"] is True
    assert armed["idle_secs"] == 600
    assert armed["max_cycles"] == 300
    assert armed["max_runtime_secs"] == 86400
    assert armed["replace_existing"] is False
    assert "replace_stopped" not in armed
    assert armed["message"] == conductor_patrol.PATROL_MESSAGE
    assert any(e.get("outcome") == "success" for e in audits)


@pytest.mark.asyncio
async def test_member_conductor_arm_writes_the_trust_record_through_the_authorizer(
    svc, audits, trust_record
):
    """A member-mode conductor is admitted only as a self-arm, and the authorizer
    itself writes the keystone-gated record -- never this module."""
    item_id = await _setup(mode="member")
    body = await _bind(item_id, WORKER)

    assert body["patrol"] == conductor_patrol.ARMED
    assert svc.added[0].get("self_armed") is True
    assert trust_record == [(svc.added[0]["loop_id"], CONDUCTOR)]
    assert any(e.get("outcome") == "self_armed" for e in audits)


# ── never stack ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_second_bind_does_not_arm_a_second_loop(svc, audits):
    item_one = await _setup()
    await _bind(item_one, WORKER)
    item_two = await _create("item two")
    body = await _bind(item_two, WORKER_2)

    assert body["patrol"] == conductor_patrol.EXISTING
    assert len(svc.added) == 1


@pytest.mark.asyncio
async def test_a_stopped_retained_loop_is_left_alone(svc, audits):
    """A person's stop must not be revived by a later bind."""
    item_id = await _setup()
    stopped = SimpleNamespace(id="kept", slot_key=CONDUCTOR, active=False)
    svc.loops[CONDUCTOR] = stopped
    body = await _bind(item_id, WORKER)

    assert body["patrol"] == conductor_patrol.EXISTING
    assert svc.added == []
    assert svc.loops[CONDUCTOR] is stopped


# ── a refused arm does not fail the bind ──────────────────────────────────


@pytest.mark.asyncio
async def test_refused_arm_logs_warning_and_bind_still_succeeds(svc, audits, caplog):
    item_id = await _setup(memory_mode="temporary")
    with caplog.at_level(logging.WARNING, logger="kiro_crew.conductor_patrol"):
        body = await _bind(item_id, WORKER)

    assert body["patrol"] == conductor_patrol.REFUSED
    assert body["item"]["worker_session_key"] == WORKER
    assert wl.read_binding(WORKER) is not None
    assert svc.added == []
    assert any("conductor patrol arm refused" in r.getMessage() for r in caplog.records)


@pytest.mark.asyncio
async def test_an_authorizer_crash_does_not_fail_the_bind(svc, monkeypatch, caplog):
    async def _boom(**kw: Any) -> Any:
        raise RuntimeError("store wedged")

    monkeypatch.setattr(autonudge_authz, "authorize_and_add_nudge", _boom)
    item_id = await _setup()
    with caplog.at_level(logging.WARNING, logger="kiro_crew.conductor_patrol"):
        body = await _bind(item_id, WORKER)

    assert body["patrol"] == conductor_patrol.REFUSED
    assert wl.read_binding(WORKER) is not None


@pytest.mark.asyncio
async def test_disabled_autonudge_reports_unsupported(monkeypatch):
    monkeypatch.setattr(autonudge, "get_instance", lambda: None)
    item_id = await _setup()
    body = await _bind(item_id, WORKER)
    assert body["patrol"] == conductor_patrol.UNSUPPORTED


# ── the unpatrolled backstop ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_open_item_is_unpatrolled_while_no_active_loop(svc):
    item_id = await _setup()
    rows = {r["item_id"]: r for r in (await _read())["items"]}
    assert rows[item_id]["unpatrolled"] is True

    svc.loops[CONDUCTOR] = SimpleNamespace(id="x", slot_key=CONDUCTOR, active=False)
    rows = {r["item_id"]: r for r in (await _read())["items"]}
    assert rows[item_id]["unpatrolled"] is True

    svc.loops[CONDUCTOR].active = True
    rows = {r["item_id"]: r for r in (await _read())["items"]}
    assert rows[item_id]["unpatrolled"] is False


@pytest.mark.asyncio
async def test_closed_item_is_never_unpatrolled(svc):
    item_id = await _setup()
    status, body = await _record({"action": "close", "item_id": item_id, "state": "abandoned"})
    assert status == 200, body
    rows = {r["item_id"]: r for r in (await _read())["items"]}
    assert rows[item_id]["unpatrolled"] is False


# ── the defaults pass the conductor's own budget check ────────────────────


def test_defaults_pass_patrol_budget_check():
    pb = load_skill_script("patrol_budget_for_conductor_patrol", PATROL_BUDGET)
    _doc, code = pb.check(
        conductor_patrol.PATROL_INTERVAL_SECS,
        conductor_patrol.PATROL_MAX_CYCLES,
        conductor_patrol.PATROL_MAX_RUNTIME_SECS,
    )
    assert code == 0
    assert 300 <= conductor_patrol.PATROL_INTERVAL_SECS <= 900
