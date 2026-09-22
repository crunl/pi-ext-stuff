import { describe, expect, it } from "vitest";
import { preparePermissionedBashArguments } from "../src/shell-permissions.ts";

describe("preparePermissionedBashArguments", () => {
  it("drops unknown keys and leaves declared values unchanged", () => {
    const input = {
      command: "pwd",
      description: "where am I",
      timeout: 180000,
    };

    expect(preparePermissionedBashArguments(input)).toEqual({
      command: "pwd",
      timeout: 180000,
    });
    expect(input).toEqual({
      command: "pwd",
      description: "where am I",
      timeout: 180000,
    });
  });

  it("does not copy description into justification", () => {
    expect(
      preparePermissionedBashArguments({
        command: "git status",
        description: "show status",
        justification: "need git metadata",
      }),
    ).toEqual({
      command: "git status",
      justification: "need git metadata",
    });
  });

  it("drops unknown keys nested in additional permissions", () => {
    expect(
      preparePermissionedBashArguments({
        command: "touch notes.txt",
        sandbox_permissions: "with_additional_permissions",
        additional_permissions: {
          network: true,
          file_system: {
            mode: "write",
            write: ["notes.txt"],
          },
        },
        justification: "the command writes one file",
      }),
    ).toEqual({
      command: "touch notes.txt",
      sandbox_permissions: "with_additional_permissions",
      additional_permissions: {
        file_system: {
          write: ["notes.txt"],
        },
      },
      justification: "the command writes one file",
    });
  });

  it("returns non-objects unchanged", () => {
    expect(preparePermissionedBashArguments(null)).toBeNull();
    expect(preparePermissionedBashArguments("pwd")).toBe("pwd");
    expect(preparePermissionedBashArguments(["pwd"])).toEqual(["pwd"]);
  });
});
