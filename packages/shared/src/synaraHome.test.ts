import * as Path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSynaraHomeDirectory } from "./synaraHome";

describe("Vibeinator home isolation", () => {
  it("does not inherit a Synara data home", () => {
    const homeDirectory = Path.resolve("test-user");
    expect(
      resolveSynaraHomeDirectory({ homeDirectory, env: { SYNARA_HOME: "original-data" } }),
    ).toBe(Path.join(homeDirectory, ".vibeinator"));
  });

  it("honors a deliberate Vibeinator home override", () => {
    expect(resolveSynaraHomeDirectory({ env: { VIBEINATOR_HOME: "test-data" } })).toBe(
      Path.resolve("test-data"),
    );
  });
});
