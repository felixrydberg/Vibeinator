import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { launch } = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("electron", () => ({ default: "fixture-electron" }));
vi.mock("./source-desktop-launch.mjs", () => ({ spawnSourceDesktop: launch }));
vi.mock("node:fs", () => ({ mkdtempSync: () => "/isolated-smoke-fixture", rmSync: vi.fn() }));

let child;
let exit;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
  launch.mockReturnValue(child);
  exit = vi.spyOn(process, "exit").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("allows cold startup beyond twenty seconds, then settles after split readiness output", async () => {
  await import("./smoke-test.mjs");
  await vi.advanceTimersByTimeAsync(25_000);
  expect(child.kill).not.toHaveBeenCalled();
  child.stdout.emit("data", Buffer.from("Synara run"));
  child.stdout.emit("data", Buffer.from("ning"));
  await vi.advanceTimersByTimeAsync(1_999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(child.kill).toHaveBeenCalledTimes(1);
  child.emit("exit", null, "SIGTERM");
  expect(exit).toHaveBeenCalledWith(0);
});

it.each([false, true])(
  "fails an expired startup with late readiness=%s and retains forced-exit escalation",
  async (lateReadiness) => {
    await import("./smoke-test.mjs");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");
    if (lateReadiness) child.stdout.emit("data", Buffer.from("Synara running"));
    child.emit("exit", null, "SIGTERM");
    expect(exit).toHaveBeenCalledWith(1);
  },
);

it("fails a fatal startup error even when the backend reported readiness", async () => {
  await import("./smoke-test.mjs");
  child.stdout.emit("data", Buffer.from("Synara running"));
  child.stderr.emit("data", Buffer.from("Uncaught TypeError: synthetic startup failure"));
  await vi.advanceTimersByTimeAsync(2_000);
  child.emit("exit", null, "SIGTERM");
  expect(exit).toHaveBeenCalledWith(1);
});
