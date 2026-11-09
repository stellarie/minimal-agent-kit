const { faultCases, boundaryCases } = require("../faults");

// Seed: a unit that calls one mocked dependency, run against every fault.
async function loadUser(api, id) {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return { error: "bad id" };
  try {
    const user = await api.getUser(id);
    if (!user || typeof user.name !== "string") return { error: "bad response" };
    return { name: user.name };
  } catch {
    return { error: "unavailable" };
  }
}

test("returns the name on success", async () => {
  const api = { getUser: jest.fn().mockResolvedValue({ name: "Ann" }) };
  expect(await loadUser(api, 1)).toEqual({ name: "Ann" });
});

test.each(faultCases(["error", "reject", "timeout", "empty", "malformed", "wrongType"]))(
  "fault %s gives an error result",
  async (_, impl) => {
    const api = { getUser: jest.fn(impl) };
    expect(await loadUser(api, 1)).toHaveProperty("error");
  },
);

test.each(boundaryCases(["number", "missing"]))("boundary %s %p is handled", async (_, id) => {
  const api = { getUser: jest.fn().mockResolvedValue({ name: "Ann" }) };
  const result = await loadUser(api, id);
  expect(result.name === "Ann" || result.error === "bad id").toBe(true);
});
