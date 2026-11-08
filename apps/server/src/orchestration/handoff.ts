import type { OrchestrationMessage, OrchestrationThread } from "@synara/contracts";
import { selectNewestHandoffMessages } from "./handoffSelection.ts";

const RECENT_MESSAGE_COUNT = 6;
const EARLIER_MESSAGE_CHAR_LIMIT = 320;
const RECENT_MESSAGE_CHAR_LIMIT = 2_400;
// Hard ceiling for any bootstrap transcript: it replays as one uncached user
// message, so long threads must drop their oldest summaries rather than grow.
const BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET = 32_000;

export interface TranscriptBootstrap {
  readonly text: string;
  readonly omittedMessages: number;
  readonly shortenedMessages: number;
}

function normalizeMessageText(value: string): string {
  return value
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function roleLabel(message: Pick<OrchestrationMessage, "role">): "User" | "Assistant" {
  return message.role === "assistant" ? "Assistant" : "User";
}

function earlierSummaryHeader(omittedCount: number): string {
  return omittedCount > 0
    ? `Earlier conversation summary (${omittedCount} older ${
        omittedCount === 1 ? "message" : "messages"
      } omitted to fit the context budget):`
    : "Earlier conversation summary:";
}

export function listImportedHandoffMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<OrchestrationMessage> {
  return thread.messages.filter(
    (message) =>
      message.source === "handoff-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function listImportedForkMessages(
  thread: Pick<OrchestrationThread, "messages">,
): ReadonlyArray<OrchestrationMessage> {
  return thread.messages.filter(
    (message) =>
      message.source === "fork-import" &&
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false,
  );
}

export function hasNativeHandoffMessages(thread: Pick<OrchestrationThread, "messages">): boolean {
  return thread.messages.some(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      (message.source === "native" || message.source === "async-user-input") &&
      message.streaming === false,
  );
}

export function hasNativeAssistantMessagesBefore(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId?: string,
): boolean {
  const currentIndex =
    currentMessageId === undefined
      ? thread.messages.length
      : thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return false;
  }
  return thread.messages.slice(0, currentIndex).some((message) => {
    return (
      message.role === "assistant" && message.source === "native" && message.streaming === false
    );
  });
}

export function listPriorTranscriptMessages(
  thread: Pick<OrchestrationThread, "messages">,
  currentMessageId?: string,
): ReadonlyArray<OrchestrationMessage> {
  const currentIndex =
    currentMessageId === undefined
      ? thread.messages.length
      : thread.messages.findIndex((message) => message.id === currentMessageId);
  if (currentIndex <= 0) {
    return [];
  }

  return thread.messages.slice(0, currentIndex).filter((message) => {
    return (
      (message.role === "user" || message.role === "assistant") &&
      message.streaming === false &&
      message.text.trim().length > 0
    );
  });
}

function buildImportedMessagesBootstrap(input: {
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath">;
  importedMessages: ReadonlyArray<OrchestrationMessage>;
  intro: string;
  maxChars: number;
}): TranscriptBootstrap | null {
  if (input.importedMessages.length === 0) return null;
  const maxChars = Math.floor(
    Math.min(Math.max(0, input.maxChars), BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET),
  );
  const earlierCount = Math.max(0, input.importedMessages.length - RECENT_MESSAGE_COUNT);
  const messages = input.importedMessages.map((message, index) => ({
    ...message,
    text: normalizeMessageText(message.text),
    earlier: index < earlierCount,
  }));
  const result = selectNewestHandoffMessages({
    messages,
    maxMessages: messages.length,
    maxTextChars: maxChars,
    maxOutputChars: maxChars,
    messageLimit: (index) =>
      index < earlierCount ? EARLIER_MESSAGE_CHAR_LIMIT : RECENT_MESSAGE_CHAR_LIMIT,
    render: (selected) => {
      const sections = [input.intro, `Original conversation title: ${input.thread.title}`];
      if (input.thread.branch) sections.push(`Git branch: ${input.thread.branch}`);
      if (input.thread.worktreePath) sections.push(`Worktree path: ${input.thread.worktreePath}`);
      const earlier = selected.filter((item) => item.message.earlier);
      const recent = selected.filter((item) => !item.message.earlier);
      if (earlierCount > 0)
        sections.push(
          [
            earlierSummaryHeader(earlierCount - earlier.length),
            ...earlier.map((item) => `- ${roleLabel(item.message)}: ${item.text}`),
          ].join("\n"),
        );
      sections.push(
        "Most recent imported messages:" +
          (recent.length
            ? "\n" + recent.map((item) => `${roleLabel(item.message)}:\n${item.text}`).join("\n\n")
            : ""),
      );
      return sections.join("\n\n").trim();
    },
  });
  return {
    text: result.text,
    omittedMessages: messages.length - result.selected.length,
    shortenedMessages: result.selected.filter((item) => item.shortened).length,
  };
}
export function buildHandoffBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "handoff" | "messages">,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedHandoffMessages(thread);
  if (importedMessages.length === 0 || thread.handoff === null) {
    return null;
  }

  return (
    buildImportedMessagesBootstrap({
      thread,
      importedMessages,
      intro: `This conversation was handed off from ${thread.handoff.sourceProvider}.`,
      maxChars,
    })?.text ?? null
  );
}

export function buildPriorTranscriptBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  currentMessageId: string | undefined,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  return buildPriorTranscriptBootstrap(thread, currentMessageId, maxChars)?.text ?? null;
}

export function buildPriorTranscriptBootstrap(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  currentMessageId: string | undefined,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): TranscriptBootstrap | null {
  const priorMessages = listPriorTranscriptMessages(thread, currentMessageId);
  if (priorMessages.length === 0) {
    return null;
  }

  return buildImportedMessagesBootstrap({
    thread,
    importedMessages: priorMessages,
    intro:
      "This provider session may have been restarted without native conversation state. Use this prior Synara transcript as context for the latest user message.",
    maxChars,
  });
}

export function buildForkBootstrapText(
  thread: Pick<OrchestrationThread, "title" | "branch" | "worktreePath" | "messages">,
  maxChars = BOOTSTRAP_TRANSCRIPT_CHAR_BUDGET,
): string | null {
  const importedMessages = listImportedForkMessages(thread);
  if (importedMessages.length === 0) {
    return null;
  }

  return (
    buildImportedMessagesBootstrap({
      thread,
      importedMessages,
      intro: "This sidechat was cloned from an earlier conversation.",
      maxChars,
    })?.text ?? null
  );
}
