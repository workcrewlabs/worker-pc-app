/**
 * Keeping a page the user linked to available for the questions that follow it.
 *
 * A page is read into the turn's context, and context is deliberately not
 * stored: it belongs to the message it was sent with, so reopening a
 * conversation shows only what the user actually typed. That is right for a
 * working folder's listing, which is rebuilt every turn anyway. It is wrong for
 * a link, because the obvious next thing a person does is ask a second question
 * about the same page, and by then the link is in an earlier message and the
 * text is gone. Asked "tell me what is in the link", the app answered that it
 * did not have the contents, having read them a moment earlier.
 *
 * So the page is remembered here, on the user's machine, and offered again on
 * the turns that follow. It is not remembered indefinitely: a conversation
 * moves on, and a page riding along in every later request would be paid for
 * every time and would eventually be answering questions it has nothing to do
 * with.
 */

export interface RememberedPage {
  url: string;
  /** The page as it goes to the model, already wrapped and labelled. */
  block: string;
  /** How many more link-free turns may still receive it. */
  turnsLeft: number;
  expiresAtMs: number;
}

/** How many follow-up turns keep the page. Enough for a conversation about
 *  what the page says, short enough that it does not follow the user into an
 *  unrelated subject later on. */
export const FOLLOW_UP_TURNS = 6;
/** A page read half an hour ago is unlikely to be what "it" refers to now. */
export const REMEMBER_FOR_MS = 30 * 60 * 1000;
/** A cap so a long session cannot grow this without limit. */
export const MAX_CONVERSATIONS = 8;

/**
 * The pages read in each conversation, keyed by conversation id.
 *
 * The first message of a new chat has no conversation id yet: the backend
 * creates it and reports it back when the turn finishes. So a page read on that
 * first turn is held aside and adopted once the id arrives, which is what makes
 * "paste a link, then ask about it" work at all.
 */
export class PageMemory {
  private readonly byConversation = new Map<string, RememberedPage>();
  private pending: RememberedPage | null = null;

  /** Keep this page for the turns that follow. */
  remember(conversationId: string | undefined, url: string, block: string, nowMs: number): void {
    const page: RememberedPage = {
      url,
      block,
      turnsLeft: FOLLOW_UP_TURNS,
      expiresAtMs: nowMs + REMEMBER_FOR_MS
    };
    if (!conversationId) {
      this.pending = page;
      return;
    }
    this.byConversation.set(conversationId, page);
    this.evictOldest();
  }

  /**
   * Attach the page read on the first turn to the conversation the backend just
   * created for it.
   *
   * Only ever adopted into a conversation that has nothing of its own, so a
   * finished turn cannot overwrite a page read more recently.
   */
  adopt(conversationId: string, nowMs: number): void {
    const page = this.pending;
    this.pending = null;
    if (!page || page.expiresAtMs <= nowMs) return;
    if (this.byConversation.has(conversationId)) return;
    this.byConversation.set(conversationId, page);
    this.evictOldest();
  }

  /**
   * The page to offer this turn, if there is still one worth offering.
   *
   * Asking uses one of its remaining turns, so a page fades out of the
   * conversation rather than staying in it forever.
   */
  recall(conversationId: string | undefined, nowMs: number): RememberedPage | null {
    if (!conversationId) return null;
    const page = this.byConversation.get(conversationId);
    if (!page) return null;
    if (page.expiresAtMs <= nowMs || page.turnsLeft <= 0) {
      this.byConversation.delete(conversationId);
      return null;
    }
    page.turnsLeft -= 1;
    return page;
  }

  /** Drop anything held for a conversation, and any unadopted first-turn page. */
  forget(conversationId: string | undefined): void {
    if (conversationId) this.byConversation.delete(conversationId);
    else this.pending = null;
  }

  size(): number {
    return this.byConversation.size;
  }

  /** Oldest by expiry, which for equal lifetimes is oldest by when it was read. */
  private evictOldest(): void {
    while (this.byConversation.size > MAX_CONVERSATIONS) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, page] of this.byConversation) {
        if (page.expiresAtMs < oldestAt) {
          oldestAt = page.expiresAtMs;
          oldestKey = key;
        }
      }
      if (!oldestKey) return;
      this.byConversation.delete(oldestKey);
    }
  }
}
