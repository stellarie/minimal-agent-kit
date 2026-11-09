# Slicing

Cut the work into self-contained slices before you design the parts.
Each slice is a subproblem with a contract. Later slices depend on the contract, never on the slice internals.
Prove each slice once. Then prove that the slices compose to the goal.

## Rules

1. **Self-contained.** A slice has its own files, scenarios, and claims. It leaves the system working.
2. **Contract first.** Write Pre, Post, and Invariant before you plan the code.
3. **Depend on contracts.** Slice n reads only the current system and the Posts of earlier slices. It never reads their internals.
4. **Small claims.** One to three claims per slice. More claims means the slice is too big. Cut it again.
5. **Order.** A slice comes after every slice whose Post it needs. Then put the riskiest slice first.
6. **Parallel.** Two slices can run at the same time when neither depends on the other and `calculus.md` `confluence` step 2 holds. Two slices that edit the same file never run in parallel.
7. **Keep earlier Posts.** A slice keeps the Posts of earlier slices true, or names the Post it replaces.
8. **Local repair.** When a slice claim breaks and its contract still holds, redo that slice in Phase 2. The other slices stay proved.
   If the contract must change, go back to Phase 1 for that slice and each slice that depends on it. Check their K links again.

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
2. For each n, the current system plus the Posts of slices 1 to n satisfy the Pre of slice n+1.
3. Each slice keeps the invariants of all slices, and the Posts of earlier slices (rule 7).
4. The Posts that still hold after the last slice give the Goal.

Each link is one row in the composition table. A link with no justification is a gap in the plan.

## Template

```
## Slices

### S1: <name> - risk <high | medium | low> - depends on <none | S#>
Files: <paths>
Scenarios: <ids>
Signature: S1: {<field: type>} -> {<field: type>}
Concern: <the one Post statement, or two with the cited dependency (`one-concern`)>
Effects: <reads and writes, or "none">
Pre: <statement>
Post: <statement>
Invariant: <statement, or "none">
Claims: C1.1, C1.2
Pseudocode:
  <calls and branches; mark reuse with file:line and claims with their ID>

### S2: ...

## Composition
| Link | Statement | Justification |
|---|---|---|
| K0 | Current system satisfies Pre(S1) | <file:line or test> |
| K1 | Current system + Post(S1) satisfy Pre(S2) | <argument> |
| Kinv | Each slice keeps every invariant, and keeps each earlier Post or names the Post it replaces | <argument per slice> |
| Kg | The Posts that still hold after Sn give the Goal | <argument> |
```
