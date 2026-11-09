const { createApp } = require("./app");
const { faultCases } = require("../faults");

async function request(app, path) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test("GET /items/:id returns the item", async () => {
  const store = { get: jest.fn().mockResolvedValue({ id: "1" }) };
  expect(await request(createApp(store), "/items/1")).toEqual({ status: 200, body: { id: "1" } });
});

test.each([
  ["empty", 404],
  ["error", 503],
  ["reject", 503],
  ["timeout", 503],
])("store fault %s gives status %i", async (name, status) => {
  const [[, impl]] = faultCases([name]);
  const store = { get: jest.fn(impl) };
  expect((await request(createApp(store), "/items/1")).status).toBe(status);
});
