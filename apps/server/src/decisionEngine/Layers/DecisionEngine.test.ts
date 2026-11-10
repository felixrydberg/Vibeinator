import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { DecisionQuestions, DECISION_ENGINE_MAX_RESPONSE_BYTES } from "@synara/contracts";
import { Effect, Fiber, Layer, ManagedRuntime, Schema } from "effect";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { DecisionEngine } from "../Services/DecisionEngine.ts";
import { DecisionEngineLive } from "./DecisionEngine.ts";
import { encodeDecisionCredential } from "../credentials.ts";

// A documented Ollama envelope, not a recording from an installed live Clef model.
const documented = JSON.parse(
  readFileSync(new URL("../fixtures/documented-choice.json", import.meta.url), "utf8"),
);
const questions = Schema.decodeUnknownSync(DecisionQuestions)({
  team: {
    type: "choice",
    instructions: "Which team should handle this ticket?",
    criteria: {
      billing: "Payments and refunds",
      technical: "Bugs and integrations",
      other: "None of the above",
    },
  },
});
const retained = (reason: string) => ({ status: "fallback", reason, retainInformation: true });
const fixture = async <T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  work: (endpoint: string) => Promise<T>,
) => {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("Missing fixture address");
  try {
    return await work(`http://127.0.0.1:${address.port}/v1/systemone`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
};
const runtime = (
  endpoint: string,
  overrides: { timeoutMs?: number; enabled?: boolean; credential?: string; origin?: string } = {},
) =>
  ManagedRuntime.make(
    DecisionEngineLive.pipe(
      Layer.provide(
        ServerSettingsService.layerTest({
          decisionEngine: {
            endpoint,
            timeoutMs: overrides.timeoutMs ?? 500,
            enabled: overrides.enabled ?? true,
            credentialConfigured: !!overrides.credential,
          },
        }),
      ),
      Layer.provide(
        Layer.succeed(ServerSecretStore, {
          get: () =>
            Effect.succeed(
              overrides.credential
                ? encodeDecisionCredential(overrides.origin ?? endpoint, overrides.credential)
                : null,
            ),
          set: () => Effect.die("Unexpected secret write"),
          remove: () => Effect.die("Unexpected secret removal"),
          getOrCreateRandom: () => Effect.die("Unexpected random secret"),
        }),
      ),
    ),
  );
const withEngine = async <T>(
  endpoint: string,
  work: (engine: ManagedRuntime.ManagedRuntime<DecisionEngine, unknown>) => Promise<T>,
  overrides: Parameters<typeof runtime>[1] = {},
) => {
  const engine = runtime(endpoint, overrides);
  try {
    return await work(engine);
  } finally {
    await engine.dispose();
  }
};
const decide = (
  state: unknown = "A duplicate charge; refund requested",
  input = questions,
  signal?: AbortSignal,
) =>
  Effect.gen(function* () {
    const service = yield* DecisionEngine;
    return yield* service.decide(state, input, signal ? { signal } : undefined);
  });

const assertClosed = async (connection: Promise<void>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connection,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Cancelled HTTP connection stayed open")), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

describe("System One decision client", () => {
  it("posts the named choice contract lazily and returns only validated advisory answers", async () => {
    const requests: {
      method: string | undefined;
      path: string | undefined;
      auth: string | undefined;
      body: unknown;
    }[] = [];
    await fixture(
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (data) => chunks.push(data));
        req.on("end", () => {
          requests.push({
            method: req.method,
            path: req.url,
            auth: req.headers.authorization,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
          res.end(JSON.stringify({ ...documented, tools: [{ execute: "never execute this" }] }));
        });
      },
      (endpoint) =>
        withEngine(
          endpoint,
          async (engine) => {
            await engine.runPromise(Effect.service(DecisionEngine));
            expect(requests).toEqual([]);
            const result = await engine.runPromise(decide());
            expect(result).toEqual({ status: "decided", answers: documented.answers });
            expect(requests).toEqual([
              {
                method: "POST",
                path: "/v1/systemone",
                auth: "Bearer private-test-key",
                body: { model: "clef", state: "A duplicate charge; refund requested", questions },
              },
            ]);
            expect(JSON.stringify(result)).not.toMatch(/private-test-key|never execute/);
          },
          { credential: "private-test-key" },
        ),
    );
  });

  it.each([
    ["unknown choice", { choice: "execute_tool" }, "invalid-response"],
    ["wrong type", { type: "noul" }, "invalid-response"],
    ["missing probabilities", { probabilities: {} }, "invalid-response"],
    [
      "invented option",
      { probabilities: { billing: 0.9, technical: 0.01, execute: 0.09 } },
      "invalid-response",
    ],
    [
      "invalid probability",
      { probabilities: { billing: 1.1, technical: 0, other: -0.1 } },
      "invalid-response",
    ],
    [
      "invalid total",
      { probabilities: { billing: 0.6, technical: 0.1, other: 0.1 } },
      "invalid-response",
    ],
    ["unselected maximum", { choice: "other" }, "invalid-response"],
    ["invalid confidence", { confidence: 1.1 }, "invalid-response"],
    ["zero confidence", { confidence: 0 }, "uncertain"],
    ["low confidence", { confidence: 0.49 }, "uncertain"],
    ["tied choice", { probabilities: { billing: 0.5, technical: 0.5, other: 0 } }, "uncertain"],
  ])("retains information for %s", async (_name, changes, reason) => {
    await fixture(
      (_req, res) =>
        res.end(JSON.stringify({ answers: { team: { ...documented.answers.team, ...changes } } })),
      (endpoint) =>
        withEngine(endpoint, async (engine) =>
          expect(await engine.runPromise(decide())).toEqual(retained(reason)),
        ),
    );
  });

  it.each([
    "{invalid",
    '{"answers":{}}',
    JSON.stringify({ answers: { ...documented.answers, extra: documented.answers.team } }),
  ])("rejects malformed or missing named answers: %s", async (body) => {
    await fixture(
      (_req, res) => res.end(body),
      (endpoint) =>
        withEngine(endpoint, async (engine) =>
          expect(await engine.runPromise(decide())).toEqual(retained("invalid-response")),
        ),
    );
  });

  it("rejects non-JSON state and oversized input without sending a request", async () => {
    let calls = 0;
    await fixture(
      (_req, res) => {
        calls++;
        res.end(JSON.stringify(documented));
      },
      (endpoint) =>
        withEngine(endpoint, async (engine) => {
          const cyclic: Record<string, unknown> = {};
          cyclic.self = cyclic;
          for (const state of [cyclic, new Date(), { value: Infinity }, "x".repeat(262_144)]) {
            expect(await engine.runPromise(decide(state))).toEqual(retained("invalid-request"));
          }
          expect(
            await engine.runPromise(
              Effect.gen(function* () {
                const service = yield* DecisionEngine;
                return yield* service.decide(undefined, questions);
              }),
            ),
          ).toEqual(retained("invalid-request"));
          const invalidQuestions = {
            team: {
              type: "choice",
              instructions: "Choose",
              criteria: { billing: null, technical: null, constructor: null },
            },
          };
          expect(
            await engine.runPromise(
              decide("state", invalidQuestions as unknown as DecisionQuestions),
            ),
          ).toEqual(retained("invalid-request"));
          expect(calls).toBe(0);
        }),
    );
  });

  it.each([401, 403, 404, 503])("returns a sanitized fallback for HTTP %s", async (status) => {
    await fixture(
      (_req, res) => {
        res.writeHead(status);
        res.end("private-test-key and raw state must not be returned");
      },
      (endpoint) =>
        withEngine(endpoint, async (engine) =>
          expect(await engine.runPromise(decide())).toEqual(
            retained(status === 401 || status === 403 ? "unauthorized" : "unavailable"),
          ),
        ),
    );
  });

  it("bounds streamed and declared response bytes and never follows credential-bearing redirects", async () => {
    for (const mode of ["stream", "declared", "redirect"] as const)
      await fixture(
        (_req, res) => {
          if (mode === "redirect") {
            res.writeHead(307, { Location: "http://127.0.0.1:1/leak" });
            res.end();
          } else if (mode === "declared") {
            res.writeHead(200, { "Content-Length": DECISION_ENGINE_MAX_RESPONSE_BYTES + 1 });
            res.end("{}");
          } else {
            res.writeHead(200);
            res.write("x".repeat(DECISION_ENGINE_MAX_RESPONSE_BYTES));
            res.end("extra");
          }
        },
        (endpoint) =>
          withEngine(
            endpoint,
            async (engine) =>
              expect(await engine.runPromise(decide())).toEqual(
                retained(mode === "redirect" ? "unavailable" : "invalid-response"),
              ),
            { credential: "private-test-key" },
          ),
      );
  });

  it("times out an incomplete body and aborts in-flight caller and Effect requests", async () => {
    let started!: () => void;
    let closed = Promise.resolve();
    let observed = new Promise<void>((resolve) => {
      started = resolve;
    });
    await fixture(
      (_req, res) => {
        closed = new Promise<void>((resolve) => res.once("close", resolve));
        res.writeHead(200);
        res.write('{"answers":');
        started();
      },
      async (endpoint) => {
        await withEngine(
          endpoint,
          async (engine) => expect(await engine.runPromise(decide())).toEqual(retained("timeout")),
          { timeoutMs: 100 },
        );
        await withEngine(
          endpoint,
          async (engine) => {
            const abort = new AbortController();
            observed = new Promise<void>((resolve) => {
              started = resolve;
            });
            const pending = engine.runPromise(decide("state", questions, abort.signal));
            await observed;
            const callerConnection = closed;
            abort.abort();
            expect(await pending).toEqual(retained("cancelled"));
            await assertClosed(callerConnection);
            const already = new AbortController();
            already.abort();
            expect(await engine.runPromise(decide("state", questions, already.signal))).toEqual(
              retained("cancelled"),
            );
            observed = new Promise<void>((resolve) => {
              started = resolve;
            });
            const fiber = engine.runFork(decide());
            await observed;
            const effectConnection = closed;
            await Effect.runPromise(Fiber.interrupt(fiber));
            await assertClosed(effectConnection);
          },
          { timeoutMs: 30_000 },
        );
      },
    );
  });

  it("falls back offline or disabled and refuses a credential bound to a different origin", async () => {
    await withEngine("http://127.0.0.1:1/v1/systemone", async (engine) =>
      expect(await engine.runPromise(decide())).toEqual(retained("unavailable")),
    );
    await withEngine(
      "http://127.0.0.1:1/v1/systemone",
      async (engine) => expect(await engine.runPromise(decide())).toEqual(retained("disabled")),
      { enabled: false },
    );
    let sent = false;
    await fixture(
      (_req, res) => {
        sent = true;
        res.end("{}");
      },
      (endpoint) =>
        withEngine(
          endpoint,
          async (engine) => {
            expect(await engine.runPromise(decide())).toEqual(retained("credentials"));
            expect(sent).toBe(false);
          },
          { credential: "private-test-key", origin: "https://another-host.example/v1/systemone" },
        ),
    );
  });
});
