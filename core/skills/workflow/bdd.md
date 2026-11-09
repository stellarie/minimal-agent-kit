# BDD scenarios

Write each acceptance criterion as one scenario:

```
Scenario: <behaviour in one line>
  Given <state>
  When <action>
  Then <observable outcome>
  Check: auto <test name or command> | manual <steps> | review <what to read>
```

Rules:

- The Then line names an outcome the user or a consumer sees. It never names an internal call.
- One scenario has one When.
- Name the test after the scenario: `test_given_x_when_y_then_z`.
- Use the project's test runner. Do not add a Gherkin library.
- Cover the unhappy paths of the code you touch: bad input, missing file, failed call.
