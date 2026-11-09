// Fault mocks: make a mocked dependency fail in each common way.
// Use with jest.fn(): dep.mockImplementation(FAULTS.timeout) or test.each(faultCases()).

class TimeoutError extends Error {
  constructor(message = "timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

const FAULTS = {
  error: () => { throw new Error("dependency failed"); },
  reject: () => Promise.reject(new Error("dependency failed")),
  timeout: () => Promise.reject(new TimeoutError()),
  never: () => new Promise(() => {}),
  empty: () => null,
  emptyList: () => [],
  emptyObject: () => ({}),
  malformed: () => ({ unexpected: true }),
  wrongType: () => "not the expected type",
};

const BOUNDARY = {
  number: [0, -1, 1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, NaN, Infinity],
  string: ["", " ", "a".repeat(10000), "\u0000", "\u{1F642}", "<script>", "' OR 1=1 --"],
  list: [[], [null], new Array(10000).fill(0)],
  missing: [undefined, null],
};

// Pairs for test.each: [name, implementation]. Pass names to pick a subset.
function faultCases(names = Object.keys(FAULTS)) {
  return names.map((n) => [n, FAULTS[n]]);
}

// Pairs for test.each: [kind, value] for each boundary input of the given kinds.
function boundaryCases(kinds = Object.keys(BOUNDARY)) {
  return kinds.flatMap((k) => BOUNDARY[k].map((v) => [k, v]));
}

module.exports = { FAULTS, BOUNDARY, TimeoutError, faultCases, boundaryCases };
