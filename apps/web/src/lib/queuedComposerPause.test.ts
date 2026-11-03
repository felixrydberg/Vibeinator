import { describe, expect, it } from "vitest";
import { deriveQueuedComposerPause } from "./queuedComposerPause";

describe("restored composer queue", () => {
  it("holds an unsent first turn until the user explicitly resumes", () => {
    expect(
      deriveQueuedComposerPause({
        latestTurn: null,
        activities: [],
        queuedTurnCount: 1,
        stoppedTurnId: "application-restart",
        resumedTurnId: null,
        threadError: null,
      }),
    ).toEqual({ reason: "restart", turnId: "application-restart" });
    expect(
      deriveQueuedComposerPause({
        latestTurn: null,
        activities: [],
        queuedTurnCount: 1,
        stoppedTurnId: null,
        resumedTurnId: "application-restart",
        threadError: null,
      }),
    ).toBeNull();
  });
});
