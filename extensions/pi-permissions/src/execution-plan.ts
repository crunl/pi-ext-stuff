/** A host-validated execution plan for the only privileged Git fast path. */
export interface GitInitExecutionPlan {
  kind: "git-init";
  executable: string;
  args: ["init"] | ["init", "."];
  cwd: string;
}

export type StructuredExecutionPlan = GitInitExecutionPlan;
