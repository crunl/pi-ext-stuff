import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function shiftTabAvailability(agentDir: string): Promise<"available" | "reserved"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(agentDir, "keybindings.json"), "utf8"));
  } catch {
    return "reserved";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "reserved";
  }
  const binding = (parsed as Record<string, unknown>)["app.thinking.cycle"];
  const keys =
    typeof binding === "string"
      ? [binding]
      : Array.isArray(binding) && binding.every((item) => typeof item === "string")
        ? binding
        : undefined;
  if (!keys) return "reserved";
  return keys.some((key) => key.trim().toLowerCase() === "shift+tab") ? "reserved" : "available";
}
