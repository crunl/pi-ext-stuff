/**
 * The prose the four registered tools ship to the model.
 *
 * These are here rather than inline at the registration call because each is a
 * paragraph: keeping them beside the schema made the registration block
 * unreadable, and hiding them inside it made them hard to review. Nothing here
 * decides behaviour — the copy only explains it.
 */

/** `bash` prepends the host tool's own description, so this is the addition. */
export const permissionedBashDescriptionSuffix = `When the active sandbox does not allow a required filesystem operation, use with_additional_permissions for the smallest exact sandbox write. A sandboxed write to Git metadata (.git/hooks, .git/config and similar) fails with EPERM ('could not lock config file'); that error is final for the sandboxed path — the parameter set offers no escalation, so request a narrower write with with_additional_permissions where the target allows it instead. A shell pipeline reports only the last command's exit status; run the command directly, or check the PIPESTATUS array right after, when its status matters. Public network access is reviewed automatically at the connection boundary; use request_permissions for an explicit turn-scoped grant.`;

export const permissionedBashPromptGuidelines = [
  "When the active sandbox does not allow a required filesystem operation, use with_additional_permissions for the smallest exact sandbox write and explain why. A sandboxed write to Git metadata (.git/hooks, .git/config and similar) fails with EPERM ('could not lock config file'); there is no escalation parameter, so treat that error as final for the sandboxed path: request a narrower write where the target allows it instead. A shell pipeline reports only the last command's exit status; run the command directly, or check the PIPESTATUS array right after, when its status matters. Public network access is reviewed automatically at the connection boundary; use request_permissions for an explicit turn-scoped network grant.",
] as const;

export const requestPermissionsDescription =
  "Request a turn-scoped filesystem or network permission. In auto mode, eligible requests are evaluated by Auto-review. Approval changes only the requested scope for execution attempts created afterwards in the current turn and does not disable the sandbox. Network authority freezes at attempt creation after action review, not invocation submission; a still-reviewing invocation may see an intervening grant. It does not expand an existing attempt or replay an action. Protected paths and prohibited targets remain blocked.";
