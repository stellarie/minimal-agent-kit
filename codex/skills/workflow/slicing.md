# Slicing

Cut the work into self-contained slices before you design the parts.
Each slice is a subproblem with a contract. Later slices depend on the contract, never on the slice internals.
Prove each slice once. Then prove that the slices compose to the goal.

## Rules

1. **Self-contained.** A slice has its own files, scenarios, and claims. It leaves the system working.
2. **Contract first.** Write Pre, Post, and Invariant before you plan the code.
3. **Depend on contracts.** Slice n reads only the Post of earlier slices. It never reads their internals.
4. **Small claims.** One to three claims per slice. More claims means the slice is too big. Cut it again.
5. **Order.** Put the riskiest slice first. A slice comes after every slice whose Post it needs.
6. **Parallel.** Two slices with no dependency and no shared file can run at the same time.
7. **Local repair.** When a slice claim breaks, redo that slice only. Its contract stays fixed, so the other slices stay proved.
   If the contract must change, redo each slice that depends on it.

## Contract terms

| Term | Meaning |
|---|---|
| Pre | What must be true before the slice runs. |
| Post | What is true after the slice runs. |
| Invariant | What stays true before, during, and after the slice. |
| Goal | The Post of the whole change. It comes from the acceptance items. |

Write each term as a statement that is true or false. "Fast" is not a statement. "Returns in less than 200 ms for 10,000 rows" is a statement.

## Composition

The plan is correct when this chain holds:

1. The current system satisfies the Pre of slice 1.
2. For each n, the Post of slices 1 to n satisfies the Pre of slice n+1.
3. Each slice keeps every invariant.
4. The Posts of all slices together give the Goal.

Each link is one row in the composition table. A link with no justification is a gap in the plan.

## Template

```
## Slices

### S1: <name> - risk <high | medium | low> - depends on <none | S#>
Files: <paths>
Scenarios: <ids>
Pre: <statement>
Post: <statement>
Invariant: <statement, or "none">
Claims: C1.1, C1.2

### S2: ...

## Composition
| Link | Statement | Justification |
|---|---|---|
| K0 | Current system satisfies Pre(S1) | <file:line or test> |
| K1 | Post(S1) satisfies Pre(S2) | <argument> |
| Kg | Post(S1) + ... + Post(Sn) give the Goal | <argument> |
```
