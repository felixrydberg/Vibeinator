import { describe, expect, it } from "vitest";
import { resolveDesktopPublishConfig } from "./lib/desktop-publish-config.ts";

describe("desktop publication ownership", () => {
  it("ignores inherited Synara and GitHub Actions release destinations", () => {
    expect(
      resolveDesktopPublishConfig({
        SYNARA_DESKTOP_UPDATE_REPOSITORY: "Emanuele-web04/synara",
        GITHUB_REPOSITORY: "Emanuele-web04/synara",
      }),
    ).toBeUndefined();
  });

  it("requires an explicit owned feed", () => {
    expect(
      resolveDesktopPublishConfig({ VIBEINATOR_UPDATE_REPOSITORY: "owner/vibeinator" }),
    ).toEqual({ provider: "github", owner: "owner", repo: "vibeinator", releaseType: "release" });
    expect(() => resolveDesktopPublishConfig({ VIBEINATOR_UPDATE_REPOSITORY: "invalid" })).toThrow(
      "owner/repository",
    );
  });
});
