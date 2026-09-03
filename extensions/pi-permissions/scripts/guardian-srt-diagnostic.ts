import {
  runGuardianSrtDiagnostic,
  serializeGuardianDiagnosticEvent,
} from "../src/guardian-diagnostic.ts";

const result = await runGuardianSrtDiagnostic({
  cwd: process.cwd(),
  emit: (event) => {
    process.stdout.write(`${serializeGuardianDiagnosticEvent(event)}\n`);
  },
});

process.exitCode = result.exitCode;
