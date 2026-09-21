import { describe, expect, it } from "vitest";
import { withCodexToolPresentation } from "../src/tui/codex-tool-presentation.ts";

function definition(name: string) {
  const execute = async () => ({ content: [], details: undefined });
  return {
    name,
    label: name,
    description: `${name} description`,
    parameters: { type: "object" },
    execute,
  } as const;
}

describe("withCodexToolPresentation", () => {
  it("only replaces presentation fields and preserves execution identity", () => {
    const original = definition("bash");
    const decorated = withCodexToolPresentation(original);

    expect(decorated.execute).toBe(original.execute);
    expect(decorated.name).toBe(original.name);
    expect(decorated.label).toBe(original.label);
    expect(decorated.description).toBe(original.description);
    expect(decorated.parameters).toBe(original.parameters);
    expect(decorated.renderShell).toBe("self");
    expect(typeof decorated.renderCall).toBe("function");
    expect(typeof decorated.renderResult).toBe("function");
  });

  it.each(["custom-tool", "constructor", "toString"])(
    "fails fast for an unsupported tool name: %s",
    (name) => {
      expect(() => withCodexToolPresentation(definition(name))).toThrow(
        `no Codex presentation is registered for tool "${name}"`,
      );
    },
  );
});
