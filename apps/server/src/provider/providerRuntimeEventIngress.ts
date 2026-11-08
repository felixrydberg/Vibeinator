import { EventId, type ProviderRuntimeEvent } from "@synara/contracts";

import { stripDiagnosticImages } from "./stripDiagnosticImages.ts";

export const PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
export const PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE = 64;
export const PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES = 512 * 1024;

export interface SizedProviderRuntimeEvent {
  readonly event: ProviderRuntimeEvent;
  readonly bytes: number;
}

export const isLosslessRuntimeText = (
  event: ProviderRuntimeEvent,
): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
  event.type === "content.delta" &&
  ["assistant_text", "reasoning_text", "reasoning_summary_text"].includes(event.payload.streamKind);

/** Bound each journal envelope without shortening conversation text or changing retry identity. */
export function splitRuntimeTextForJournal(
  event: ProviderRuntimeEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  // Even six-byte JSON escapes stay below the 2 MiB journal budget. Ordinary
  // deltas and the pump's existing text batches keep their original identity.
  const segmentChars = 256 * 1024;
  if (!isLosslessRuntimeText(event) || event.payload.delta.length <= segmentChars) return [event];
  const result: ProviderRuntimeEvent[] = [];
  let offset = 0;
  while (offset < event.payload.delta.length) {
    let end = Math.min(offset + segmentChars, event.payload.delta.length);
    const last = event.payload.delta.charCodeAt(end - 1);
    const next = event.payload.delta.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    result.push({
      ...event,
      eventId: EventId.makeUnsafe(`${event.eventId}:text:${result.length}`),
      payload: { ...event.payload, delta: event.payload.delta.slice(offset, end) },
      ...(event.raw
        ? {
            raw: {
              ...event.raw,
              payload: {
                synaraTruncated: true,
                reason: "text journal segmentation",
                originalEventId: event.eventId,
              },
            },
          }
        : {}),
    });
    offset = end;
  }
  return result;
}

export function isTerminalProviderRuntimeEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited" ||
    event.type === "task.completed" ||
    (event.type === "task.updated" &&
      (event.payload.status === "completed" ||
        event.payload.status === "failed" ||
        event.payload.status === "killed" ||
        event.payload.status === "paused"))
  );
}
function providerRuntimeEventBytes(event: ProviderRuntimeEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8");
  } catch {
    return PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES + 1;
  }
}

/**
 * Raw provider payloads are diagnostic data. Compact them before the callback
 * ingress so one pathological native message cannot consume the whole budget.
 */
export function compactProviderRuntimeEventForIngress(
  event: ProviderRuntimeEvent,
): SizedProviderRuntimeEvent {
  event = stripDiagnosticImages(event) as ProviderRuntimeEvent;
  const originalBytes = providerRuntimeEventBytes(event);
  if (originalBytes <= PROVIDER_RUNTIME_INGRESS_EVENT_MAX_BYTES || event.raw === undefined) {
    return { event, bytes: originalBytes };
  }
  const compactedEvent: ProviderRuntimeEvent = {
    ...event,
    raw: {
      source: event.raw.source,
      ...(event.raw.method !== undefined ? { method: event.raw.method } : {}),
      ...(event.raw.messageType !== undefined ? { messageType: event.raw.messageType } : {}),
      payload: {
        synaraTruncated: true,
        reason: "provider runtime event exceeded the callback ingress size limit",
        originalBytes,
      },
    },
  };
  return {
    event: compactedEvent,
    bytes: providerRuntimeEventBytes(compactedEvent),
  };
}
