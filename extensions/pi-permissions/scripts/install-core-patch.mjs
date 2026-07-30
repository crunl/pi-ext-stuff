#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPPORTED_VERSION = "0.82.1";
const ORIGINAL_SHA256 = "d3d20bc773ccc8d5f7cfe0eabf8b421ff3da8685617445b142d89a44457741bc";
const PATCHED_SHA256 = "e4af3082d8c95203aff6bf7aa590e63d6cd1d0225723db271eeb315ded01dd63";
const MARKER = 'globalThis[Symbol.for("pi-permissions.core.execution-abort-gate.v1")] = 1;';
const IMPORT_ANCHOR = 'import { getDefaultStreamFn } from "./stream-fn.js";';
const EXECUTE_ANCHOR =
  "async function executePreparedToolCall(prepared, signal, emit) {\n    const updateEvents = [];";
const EXECUTE_REPLACEMENT =
  'async function executePreparedToolCall(prepared, signal, emit) {\n    if (signal?.aborted) {\n        return { result: createErrorToolResult("Operation aborted"), isError: true };\n    }\n    const updateEvents = [];';

const piExecutable = "/opt/homebrew/bin/pi";
const resolvedPi = await import("node:fs/promises").then(({ realpath }) => realpath(piExecutable));
export const CORE_AGENT_LOOP_PATH = join(
  dirname(dirname(resolvedPi)),
  "libexec/lib/node_modules/@earendil-works/pi-coding-agent/node_modules",
  "@earendil-works/pi-agent-core/dist/agent-loop.js",
);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function assertSupportedVersion(target) {
  const packageJsonPath = join(dirname(dirname(target)), "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
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
  const backup = `${absoluteTarget}.pi-permissions-0.82.1.orig`;
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
