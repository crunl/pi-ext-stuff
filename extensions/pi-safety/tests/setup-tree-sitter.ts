import { beforeAll } from "vitest";
import { installShellAstParser } from "../src/permissions/shell-ast.ts";
import {
  ensureTreeSitterReady,
  shellAstParser,
  treeSitterShellFailure,
} from "../src/tree-sitter/shell-backend.ts";

// Sole-interpreter: every test sees the parser installed, exactly as production
// does after the ready barrier. A missing grammar fails the suite loudly rather
// than silently testing the fail-closed path.
beforeAll(async () => {
  await ensureTreeSitterReady();
  const parser = shellAstParser();
  if (!parser) {
    throw new Error(
      `tree-sitter grammar unavailable in tests: ${JSON.stringify(treeSitterShellFailure())}`,
    );
  }
  installShellAstParser(parser);
});
