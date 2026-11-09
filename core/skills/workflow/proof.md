# Proof

A claim is a statement that is true or false. A proof is an argument a reader can check.
Tests are evidence for a claim. Tests are not the claim.

## Claims

Write each claim from a slice contract or a scenario. Give each claim an ID: `C<slice>.<n>`.
Make the claim cover all inputs that the slice accepts, not one example.

## Strength

| Strength | Meaning | Required evidence |
|---|---|---|
| proved | An argument from the code shows the claim for every input. | A technique below, with `file:line` for each step. |
| tested | Tests support the claim. No argument covers every input. | Test names, and the input classes they cover. |
| assumed | Nothing in this repository shows the claim. | The source, for example vendor docs. |

Rules:

- Use the strongest strength you can show. Do not claim more.
- A machine check (a type checker or a solver) that covers every input counts as `proved`.
- `tested` needs a repeatable test. Fix the seed of each random input. A spike test in the sandbox counts.
- `assumed` rows block the gate until the human accepts them by ID. `verify_plan.py` checks this.
- A claim about all inputs needs `proved`, or `tested` with each input class covered.
- Each `assumed` row is a risk. List it at the approval gate. The human accepts it by ID.
- Small slice: a slice planned at less than about 20 lines, with no invariant, needs only its Post at `tested`. Its K link gives its Pre.
  If the slice grows past about 20 lines in Phase 2, stop and write its full claims.

## Techniques

### Case analysis

Use it when the input falls into classes.

1. List each class of input. Include empty, null, maximum, and invalid input.
2. Show the classes are exhaustive: each possible input is in one class. Name the default branch.
3. Show the claim for each class.

```
Example, with invented line numbers:
Claim C2.1: parse(x) returns a Token or raises ParseError, for every string x.
Cases: (a) empty string, (b) valid token, (c) invalid prefix, (d) other.
Exhaustive: (d) is the else branch at parser.py:40.
(a) parser.py:12 raises ParseError. (b) parser.py:20 returns Token. (c) parser.py:31 raises ParseError. (d) parser.py:40 raises ParseError.
```

### Induction

Use it for a loop, a recursion, or a sequence of steps.

1. State the loop invariant.
2. Base: the invariant holds before the first step.
3. Step: if the invariant holds before a step, it holds after the step.
4. End: the loop stops, and the invariant plus the stop condition give the claim.

```
Example, with invented line numbers:
Claim C3.1: merge(a, b) returns a sorted list when a and b are sorted.
Invariant: out is sorted, and out[-1] <= a[i] and out[-1] <= b[j].
Base: out is empty (merge.py:5).
Step: the smaller head goes to out (merge.py:9), so the invariant holds.
End: i + j grows each step and is bounded by len(a) + len(b). The remainder is sorted and >= out[-1].
```

### Contradiction

Use it for a safety claim: "X never happens".

1. Assume X happens.
2. Follow the code to the point where X must occur.
3. Show a check, type, or earlier claim that stops it.

```
Example, with invented line numbers:
Claim C1.2: no request reaches save_order() without a valid session.
Assume a request reaches save_order() with no valid session.
Each route to save_order() goes through the auth middleware (app.py:14). Show that the list of routes is complete with a search, not by hand.
The middleware returns 401 before the handler when the session is not valid (auth.py:22). Contradiction.
Most gaps hide in the first step: the list of each path to the code. Derive it, then prove it is complete.
```

### Contract chaining

Use it for composition rows. Show that each statement in Pre(Sn+1) follows from the current system and the Posts before it.
Show that no later slice makes an earlier Post false, unless that slice names the Post it replaces.
Cite the Post by slice ID. Do not reason from slice internals.

## Obligation table

Put this table in the design file. One row per claim and one row per composition link.
For a composition link, write the justification in the Composition table only. Here, write "see K#".

```
## Proof obligations
| ID | Claim | Technique | Strength | Justification | Test |
|---|---|---|---|---|---|
| C1.1 | <statement> | case analysis | proved | <steps with file:line> | <test name> |
| C1.2 | <statement> | - | assumed | <source> | - |
| K1 | Post(S1) satisfies Pre(S2) | chaining | proved | see K1 | - |
```

## Tests for claims

- Name each test after its claim, for example `test_c2_1_parse_empty_raises`.
- Cover each case from a case analysis with at least one test.
- Prefer a property-based test (Hypothesis, fast-check) for a claim about all inputs, when the project has the library.
- Each test that this change adds names a claim or a scenario. Do not delete existing project tests for this rule.
- Check that each test can fail: break the code for a moment, see the test fail, then restore the code.
