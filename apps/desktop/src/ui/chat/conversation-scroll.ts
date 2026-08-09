const FOLLOW_THRESHOLD = 48;

type FollowState = { following: boolean };

const states = new WeakMap<HTMLElement, FollowState>();

function stateFor(messages: HTMLElement): FollowState {
  const existing = states.get(messages);
  if (existing) return existing;
  const state = { following: true };
  messages.addEventListener("scroll", () => {
    state.following = messages.scrollHeight - messages.scrollTop - messages.clientHeight < FOLLOW_THRESHOLD;
  }, { passive: true });
  states.set(messages, state);
  return state;
}

/** Keeps live output pinned only while the reader is already following the latest message. */
export function scrollToLatestIfFollowing(messages: HTMLElement): void {
  if (stateFor(messages).following) messages.scrollTop = messages.scrollHeight;
}

/** Explicit navigation to the latest message resumes automatic follow mode. */
export function resumeFollowingLatest(messages: HTMLElement): void {
  stateFor(messages).following = true;
}

export function isFollowingLatest(messages: HTMLElement): boolean {
  return stateFor(messages).following;
}
