# Spike sandbox

A reusable testbed for the Spike step of the workflow (`design.md` 1.8). Code here never merges into a project.

| Folder | Contents |
|---|---|
| `python/` | pytest, `faults.py`, seed tests |
| `js/node/` | jest seed tests |
| `js/express/` | Express app with an injected store, and its tests |
| `js/react/` | React component with an injected loader, and its tests (jsdom) |
| `js/faults.js` | fault mocks and boundary inputs for jest |

## Run the tests

```bash
python/.venv/bin/python -m pytest python      # Windows: python\.venv\Scripts\python
npm test --prefix js
```

## One spike

1. Start from a clean `main`: `git switch main`, then `git switch -c spike/<task>`.
2. Copy only the pseudocode and contracts of the slices under test. Do not copy project source.
3. Mock each dependency. Give each mock an assumed-row ID in its test name, for example `test_M1_charge_returns_id`.
4. Run each mock through the fault cases (`faults.py`, `faults.js`) and the boundary inputs.
5. Record each result in the design file: the row ID, the test name, and pass or fail.
6. Commit on the spike branch. Never merge it into `main`.

## Dependencies from the target project

A contract test can need the real dependency. Then install it from the target project's own manifest, on the spike branch only:

```bash
python/.venv/bin/python -m pip install -r <project>/requirements.txt
npm install --prefix js --no-save <package>@<version from the project lockfile>
```

Use the exact versions from the project lockfile. Before the next spike, restore the sandbox: `git switch main`, `npm ci --prefix js`, and create `python/.venv` again.
