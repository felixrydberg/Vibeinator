import type {
  DurableHandoffOutcome,
  DurableHandoffPacket,
  HandoffPacketId,
  ModelSelection,
  PreparedHandoffPacket,
  ProviderDriverKind,
  ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";
import type { NativeArchiveRepositoryError, ArchiveScope } from "./NativeArchive.ts";

/** Internal admission metadata, never supplied by a client or serialized to an adapter. */
export interface HandoffDispatchPreparation {
  readonly prepared: PreparedHandoffPacket;
  readonly eventSequence: number;
  readonly reason: "handoff" | "recovery";
}
export interface StoredHandoffPacket {
  readonly packet: DurableHandoffPacket;
  readonly prepared: PreparedHandoffPacket;
  readonly eventSequence: number;
  readonly reason: HandoffDispatchPreparation["reason"];
  readonly outcomes: ReadonlyArray<DurableHandoffOutcome>;
}
export interface HandoffStoreShape {
  readonly prepare: (
    input: HandoffDispatchPreparation & {
      readonly provider: ProviderDriverKind;
      readonly providerInstanceId: string;
      readonly lifecycleGeneration: string;
      /** Exact routed application input, after all prompt additions. */
      readonly dispatchInput: ProviderSendTurnInput;
    },
  ) => Effect.Effect<HandoffPacketId, NativeArchiveRepositoryError>;
  readonly recordTurn: (
    packetId: HandoffPacketId,
    turnId: TurnId,
    acknowledged: boolean,
  ) => Effect.Effect<void, NativeArchiveRepositoryError>;
  readonly recordFailure: (
    packetId: HandoffPacketId,
  ) => Effect.Effect<void, NativeArchiveRepositoryError>;
  readonly get: (
    scope: ArchiveScope,
    packetId: HandoffPacketId,
  ) => Effect.Effect<StoredHandoffPacket | null, NativeArchiveRepositoryError>;
  readonly prepareStart: (input: {
    readonly threadId: ThreadId;
    readonly eventSequence: number;
    readonly source: ModelSelection;
    readonly target: ModelSelection;
  }) => Effect.Effect<string, NativeArchiveRepositoryError>;
  readonly finishStart: (
    id: string,
    outcome: "started" | "failed" | "uncertain",
  ) => Effect.Effect<void, NativeArchiveRepositoryError>;
}
export class HandoffStore extends ServiceMap.Service<HandoffStore, HandoffStoreShape>()(
  "vibeinator/persistence/HandoffStore",
) {}
