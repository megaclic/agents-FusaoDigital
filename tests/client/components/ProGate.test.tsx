/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { ProGate } from "@/client/components/ProGate";

describe("ProGate", () => {
  afterEach(() => cleanup());

  test("renders nothing (no Pro-only feature is gated in this edition)", () => {
    const { container } = render(<ProGate />);
    expect(container).toBeEmptyDOMElement();
  });
});
