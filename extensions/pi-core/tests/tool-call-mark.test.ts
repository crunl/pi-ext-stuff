import { describe, expect, it, vi } from "vitest";
import { markToolCall } from "../src/tui/tool-call-mark.ts";

const mark = { icon: "\u{F105E}", color: "warning" } as const;

describe("markToolCall", () => {
  it("forwards a persistent mark to a compatible host", () => {
    const hostMark = vi.fn();

    expect(markToolCall({ markToolCall: hostMark }, "call-1", mark)).toBe(true);
    expect(hostMark).toHaveBeenCalledWith("call-1", mark);
  });

  it("is a safe no-op on old or broken hosts", () => {
    expect(markToolCall({}, "call-1", mark)).toBe(false);
    expect(
      markToolCall(
        {
          markToolCall: () => {
            throw new Error("unavailable");
          },
        },
        "call-1",
        mark,
      ),
    ).toBe(false);
  });
});
