"""The session RSS ceiling measures on macOS instead of reading every tree as 0.

macOS has no ``/proc``. ``get_session_rss_mb`` and the sweep's
``_rss_mb_from_tree`` route a Mac through the runtime watchdog's own tree reader,
``acp.runtime._get_rss_tree_mb``, so ``watchdog_rss_max_mb`` can fire there and
both ceilings judge one number. Only the OS seams are faked -- the ``ps`` call
and the libproc handle -- so the real reader, tree walk and MiB maths all run;
expectations come from the same footprint bytes the fake hands out. A host that
cannot measure warns once.
"""

from __future__ import annotations

import logging
import os
import struct
import sys
import types

import pytest

from kiro_crew import platform_compat as pc
from kiro_crew import session_pid
from kiro_crew.acp import runtime as rt

_MIB = 1024 * 1024

# ``ps -Ao pid=,ppid=,rss=`` rows: 100 -> 200 -> 400 and 100 -> 300 -> 500.
_PS_OUTPUT = b"\n".join(
    [
        b"  1     0   1024",
        b"100     1   2048",
        b"200   100   2048",
        b"300   100   2048",
        b"400   200   2048",
        b"500   300   2048",
    ]
)
_FOOTPRINT = {100: 100 * _MIB + 7, 200: 50 * _MIB, 300: 300 * _MIB, 400: 25 * _MIB, 500: 9 * _MIB}


def _fake_libproc() -> types.SimpleNamespace:
    def proc_pid_rusage(pid, flavor, buf):
        if pid not in _FOOTPRINT or flavor != pc._DARWIN_RUSAGE_INFO_V2:
            return -1
        struct.pack_into("<Q", buf, pc._DARWIN_RI_PHYS_FOOTPRINT_OFFSET, _FOOTPRINT[pid])
        return 0

    return types.SimpleNamespace(proc_pid_rusage=proc_pid_rusage)


def _expected_mb(pids) -> int:
    return int(sum(_FOOTPRINT[p] for p in pids) / _MIB)


@pytest.fixture
def mac(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(session_pid.sys, "platform", "darwin")
    monkeypatch.setattr(pc, "IS_MACOS", True)
    monkeypatch.setattr(pc, "IS_WINDOWS", False)
    monkeypatch.setattr(pc, "_darwin_libproc_handle", _fake_libproc)
    monkeypatch.setattr(pc, "trusted_system_bin", lambda name: f"/bin/{name}")
    monkeypatch.setattr(rt.subprocess, "check_output", lambda *a, **kw: _PS_OUTPUT)
    monkeypatch.setattr(session_pid, "_rss_ceiling_inert_warned", False, raising=False)
    rt._reset_ps_table_cache()
    yield
    rt._reset_ps_table_cache()


@pytest.mark.usefixtures("mac")
class TestDarwinTreeMeasurement:
    def test_single_tree_sums_root_and_every_descendant(self) -> None:
        assert session_pid.get_session_rss_mb(100) == _expected_mb([100, 200, 300, 400, 500])

    def test_sweep_route_measures_without_a_proc_map(self) -> None:
        """The recycle sweep calls ``_rss_mb_from_tree`` with the (empty) map."""
        child_map = session_pid._build_child_map()
        got = session_pid._rss_mb_from_tree(100, child_map)
        assert got == _expected_mb([100, 200, 300, 400, 500])
        assert got > 0

    def test_a_subtree_root_measures_only_its_subtree(self) -> None:
        assert session_pid.get_session_rss_mb(300) == _expected_mb([300, 500])

    def test_session_and_runtime_ceilings_read_the_same_number(self) -> None:
        assert session_pid.get_session_rss_mb(100) == int(rt._get_rss_tree_mb(100))

    def test_an_excluded_root_measures_nothing(self) -> None:
        assert session_pid.get_session_rss_mb(100, exclude_pids={100}) == 0

    def test_an_unknown_root_is_zero_not_a_guess(self) -> None:
        assert session_pid.get_session_rss_mb(999) == 0

    def test_measuring_logs_no_inert_warning(self, caplog: pytest.LogCaptureFixture) -> None:
        with caplog.at_level(logging.WARNING, logger=session_pid.logger.name):
            session_pid.get_session_rss_mb(100)
        assert "cannot measure" not in caplog.text


def test_an_unsupported_platform_warns_once(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(pc, "IS_WINDOWS", False)
    monkeypatch.setattr(session_pid, "_rss_ceiling_inert_warned", False, raising=False)
    monkeypatch.setattr(session_pid.sys, "platform", "freebsd14")
    with caplog.at_level(logging.WARNING, logger=session_pid.logger.name):
        assert session_pid.get_session_rss_mb(100) == 0
        assert session_pid._rss_mb_from_tree(100, {}) == 0
    warnings = [r.getMessage() for r in caplog.records if "cannot measure" in r.getMessage()]
    assert len(warnings) == 1
    assert "freebsd14" in warnings[0]


@pytest.mark.skipif(sys.platform != "darwin", reason="reads the real libproc, which only a Mac has")
def test_real_mac_measures_our_own_process() -> None:
    """Live canary: our own pytest process has a non-zero footprint."""
    assert session_pid.get_session_rss_mb(os.getpid()) > 0
