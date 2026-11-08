import { unicodeSafeEndOffset } from "@synara/shared/text";

export interface HandoffExcerpt<T> {
  readonly message: T;
  readonly text: string;
  readonly retainedChars: number;
  readonly shortened: boolean;
}

export function fitHandoffText(text: string, maxChars: number) {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return { text, retainedChars: text.length, shortened: false };
  const marker = "...".slice(0, limit);
  const end = unicodeSafeEndOffset(text, Math.max(0, limit - marker.length));
  return { text: text.slice(0, end) + marker, retainedChars: end, shortened: true };
}

/** Select before rendering: an older excerpt can never consume a newer message's allowance. */
export function selectNewestHandoffMessages<T extends { readonly text: string }>(input: {
  readonly messages: ReadonlyArray<T>;
  readonly maxMessages: number;
  readonly maxTextChars: number;
  readonly maxOutputChars: number;
  readonly messageLimit: (index: number) => number;
  readonly render: (selected: ReadonlyArray<HandoffExcerpt<T>>) => string;
}): { readonly text: string; readonly selected: ReadonlyArray<HandoffExcerpt<T>> } {
  const selected: Array<HandoffExcerpt<T>> = [];
  let usedTextChars = 0;
  for (
    let index = input.messages.length - 1;
    index >= 0 && selected.length < input.maxMessages;
    index--
  ) {
    const message = input.messages[index]!;
    const limit = Math.max(
      0,
      Math.min(input.messageLimit(index), input.maxTextChars - usedTextChars),
    );
    const full = { message, ...fitHandoffText(message.text, limit) };
    const fits = (excerpt: HandoffExcerpt<T>) =>
      input.render([excerpt, ...selected]).length <= input.maxOutputChars;
    let chosen = full;
    if (!fits(full)) {
      let low = 0;
      let high = Math.min(limit, Math.max(0, message.text.length - 1));
      let best: HandoffExcerpt<T> | null = null;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const excerpt = { message, ...fitHandoffText(message.text, middle) };
        if (fits(excerpt)) {
          best = excerpt;
          low = middle + 1;
        } else high = middle - 1;
      }
      if (best === null || (best.retainedChars === 0 && message.text.length > 0)) break;
      chosen = best;
    }
    if (chosen.retainedChars === 0 && message.text.length > 0) break;
    selected.unshift(chosen);
    usedTextChars += chosen.text.length;
    if (chosen.retainedChars < full.retainedChars) break;
  }
  // Only metadata can need clipping here. Excerpts always pass the complete renderer's bound.
  return { text: fitHandoffText(input.render(selected), input.maxOutputChars).text, selected };
}
