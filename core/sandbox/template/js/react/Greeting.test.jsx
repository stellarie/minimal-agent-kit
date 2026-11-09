/** @jest-environment jsdom */
import { render, screen } from "@testing-library/react";
import Greeting from "./Greeting";
import { faultCases } from "../faults";

test("shows the name", async () => {
  render(<Greeting load={jest.fn().mockResolvedValue({ name: "Ann" })} />);
  expect(await screen.findByText("Hello, Ann")).toBeTruthy();
});

test.each(faultCases(["error", "reject", "timeout", "empty", "malformed"]))(
  "fault %s shows the error",
  async (_, impl) => {
    render(<Greeting load={jest.fn(impl)} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
  },
);
