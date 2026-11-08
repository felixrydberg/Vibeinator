import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@synara/contracts";

export type ProviderContextTag = "handoff_context" | "sidechat_context" | "thread_context";
export interface BootstrapContextSelection {
  readonly tag: ProviderContextTag;
  readonly contextText: string;
  readonly wrapLatestUserMessage: boolean;
}
export function wrapProviderContext(
  input: BootstrapContextSelection & { readonly messageText: string },
): string {
  const messageSection = input.wrapLatestUserMessage
    ? `<latest_user_message>\n${input.messageText}\n</latest_user_message>`
    : input.messageText;
  return `<${input.tag}>\n${input.contextText}\n</${input.tag}>\n\n${messageSection}`;
}
export function availableProviderContextChars(
  input: Omit<BootstrapContextSelection, "contextText"> & {
    readonly messageText: string;
    readonly reservedChars?: number;
    readonly maxInputChars?: number;
  },
): number {
  return Math.max(
    0,
    (input.maxInputChars ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS) -
      wrapProviderContext({ ...input, contextText: "" }).length -
      (input.reservedChars ?? 0),
  );
}
