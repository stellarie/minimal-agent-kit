const express = require("express");

// Seed: an Express app whose store is injected, so tests can mock it.
function createApp(store) {
  const app = express();
  app.use(express.json());
  app.get("/items/:id", async (req, res) => {
    try {
      const item = await store.get(req.params.id);
      if (!item) return res.status(404).json({ error: "not found" });
      return res.json(item);
    } catch {
      return res.status(503).json({ error: "unavailable" });
    }
  });
  return app;
}

module.exports = { createApp };
