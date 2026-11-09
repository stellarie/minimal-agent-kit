from unittest import mock

import pytest

from faults import boundary_cases, fault_cases


def load_user(api, user_id):
    """Seed: a unit that calls one mocked dependency."""
    if not isinstance(user_id, int) or isinstance(user_id, bool) or not 1 <= user_id < 2**31:
        return {"error": "bad id"}
    try:
        user = api.get_user(user_id)
    except (RuntimeError, TimeoutError, ConnectionError):
        return {"error": "unavailable"}
    if not isinstance(user, dict) or not isinstance(user.get("name"), str):
        return {"error": "bad response"}
    return {"name": user["name"]}


def test_success():
    api = mock.Mock()
    api.get_user.return_value = {"name": "Ann"}
    assert load_user(api, 1) == {"name": "Ann"}


@pytest.mark.parametrize("name, effect", fault_cases())
def test_fault_gives_error(name, effect):
    api = mock.Mock()
    api.get_user.side_effect = effect
    assert "error" in load_user(api, 1)


@pytest.mark.parametrize("kind, value", boundary_cases(["int", "missing"]))
def test_boundary(kind, value):
    api = mock.Mock()
    api.get_user.return_value = {"name": "Ann"}
    result = load_user(api, value)
    assert result.get("name") == "Ann" or result.get("error") == "bad id"
