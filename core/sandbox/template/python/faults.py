"""Fault mocks: make a mocked dependency fail in each common way.

Use with unittest.mock: dep.side_effect = FAULTS["timeout"], or
@pytest.mark.parametrize("name, effect", fault_cases()).
"""


def _raise(exc):
    def effect(*args, **kwargs):
        raise exc
    return effect


def _value(value):
    def effect(*args, **kwargs):
        return value
    return effect


FAULTS = {
    "error": _raise(RuntimeError("dependency failed")),
    "timeout": _raise(TimeoutError("timed out")),
    "connection": _raise(ConnectionError("connection refused")),
    "empty": _value(None),
    "empty_list": _value([]),
    "empty_dict": _value({}),
    "malformed": _value({"unexpected": True}),
    "wrong_type": _value("not the expected type"),
}

BOUNDARY = {
    "int": [0, -1, 1, 2**31 - 1, -(2**31), 2**63],
    "float": [0.0, -0.0, float("nan"), float("inf")],
    "str": ["", " ", "a" * 10000, "\x00", "\U0001F642", "<script>", "' OR 1=1 --"],
    "list": [[], [None], [0] * 10000],
    "missing": [None],
}


def fault_cases(names=None):
    """Pairs (name, side_effect) for parametrize. Pass names to pick a subset."""
    return [(n, FAULTS[n]) for n in (names or FAULTS)]


def boundary_cases(kinds=None):
    """Pairs (kind, value) for each boundary input of the given kinds."""
    return [(k, v) for k in (kinds or BOUNDARY) for v in BOUNDARY[k]]
