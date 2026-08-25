#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPPORTED_VERSION = "0.84.3";
const ORIGINAL_SHA256 = "43cc779ddaf90df41768d3d2d0f7d7ba8b8bce7bedc9dc6062ca8b4de84ae880";
const PATCHED_SHA256 = "7e128be26d958a7f6ef2b93b3c4c4fd8a03b22452fb60d0a0a120908ca15dd6a";
const MARKER = 'globalThis[Symbol.for("pi-permissions.core.execution-abort-gate.v1")] = 1;';
const IMPORT_ANCHOR = 'import { getDefaultStreamFn } from "./stream-fn.js";';
const EXECUTE_ANCHOR =
  "async function executePreparedToolCall(prepared, signal, emit) {\n    const updateEvents = [];";
const EXECUTE_REPLACEMENT =
  'async function executePreparedToolCall(prepared, signal, emit) {\n    if (signal?.aborted) {\n        return { result: createErrorToolResult("Operation aborted"), isError: true };\n    }\n    const updateEvents = [];';

const piExecutable = "/opt/homebrew/bin/pi";
const resolvedPi = await import("node:fs/promises").then(({ realpath }) => realpath(piExecutable));
import { existsSync } from "node:fs";

// The bundled pi-agent-core moved between Pi releases: newer layouts keep it at
// <pi-package>/node_modules/@earendil-works/pi-agent-core, older ones nested it
// under dist/libexec/lib. Probe both so the installer survives either packaging.
function resolveCoreAgentLoopPath() {
  const piPackageDir = dirname(dirname(resolvedPi));
  const candidates = [
    join(piPackageDir, "../node_modules", "@earendil-works/pi-agent-core/dist/agent-loop.js"),
    join(
      piPackageDir,
      "libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
      "@earendil-works/pi-agent-core/dist/agent-loop.js",
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}
export const CORE_AGENT_LOOP_PATH = resolveCoreAgentLoopPath();
export const coreBackupSuffix = `.pi-permissions-${SUPPORTED_VERSION}.orig`;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function assertSupportedVersion(target) {
  const packageJsonPath = join(dirname(dirname(target)), "package.json");
  let packageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `cannot read pi-agent-core manifest at ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    packageJson.name !== "@earendil-works/pi-agent-core" ||
    packageJson.version !== SUPPORTED_VERSION
  ) {
    throw new Error(
      `pi-permissions core patch supports pi-agent-core ${SUPPORTED_VERSION}; found ${packageJson.name ?? "unknown"} ${packageJson.version ?? "unknown"}`,
    );
  }
}

export async function corePatchStatus(target = CORE_AGENT_LOOP_PATH) {
  const absoluteTarget = resolve(target);
  await assertSupportedVersion(absoluteTarget);
  const source = await readFile(absoluteTarget, "utf8");
  const hash = sha256(source);
  if (hash === PATCHED_SHA256 && source.includes(MARKER)) return "installed";
  if (hash === ORIGINAL_SHA256 && !source.includes(MARKER)) return "not-installed";
  throw new Error(`unsupported core source hash: ${hash}`);
}

export async function installCorePatch(target = CORE_AGENT_LOOP_PATH) {
  const absoluteTarget = resolve(target);
  const status = await corePatchStatus(absoluteTarget);
  if (status === "installed") return "already-installed";

  const source = await readFile(absoluteTarget, "utf8");
  if (!source.includes(IMPORT_ANCHOR) || !source.includes(EXECUTE_ANCHOR)) {
    throw new Error("supported core source is missing a required patch anchor");
  }
  const patched = source
    .replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${MARKER}`)
    .replace(EXECUTE_ANCHOR, EXECUTE_REPLACEMENT);
  if (sha256(patched) !== PATCHED_SHA256) {
    throw new Error("generated core patch does not match the expected patched hash");
  }

  const sourceMode = (await stat(absoluteTarget)).mode;
  const backup = `${absoluteTarget}${coreBackupSuffix}`;
  const temporary = `${absoluteTarget}.pi-permissions-new`;
  await copyFile(absoluteTarget, backup, 1);
  await writeFile(temporary, patched, { mode: sourceMode });
  await rename(temporary, absoluteTarget);
  return "installed";
}

async function main() {
  const args = process.argv.slice(2);
  const coreFileIndex = args.indexOf("--core-file");
  const target =
    coreFileIndex === -1 ? CORE_AGENT_LOOP_PATH : args[coreFileIndex + 1] || CORE_AGENT_LOOP_PATH;
  if (args.includes("--check")) {
    const status = await corePatchStatus(target);
    if (status !== "installed") throw new Error("core execution abort gate is not installed");
    process.stdout.write(`verified ${resolve(target)} (${PATCHED_SHA256})\n`);
    return;
  }
  const result = await installCorePatch(target);
  process.stdout.write(`${result}: ${resolve(target)}\n`);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
