// Decide how a typed message is handled: answered in chat, or run as a task on the
// user's computer. The user makes that choice explicitly with the Chat / Computer
// use toggle under the message box, so routing is never a guess: Chat NEVER touches
// the computer (a spreadsheet is written out as a file to download, not built by
// driving Excel), and Computer use acts. The string checks here only refine that
// choice: a plain question is still answered in chat, and a message typed in Chat
// mode that reads like a task offers a one-click switch instead of being hijacked.

// The two ways a message can be handled, chosen by the composer toggle.
export type ComposerMode = "chat" | "computer";

// Whether a typed message should run on the computer. Only Computer use mode acts,
// and even there a plain question ("what is in this folder") is answered in chat
// rather than opening anything on screen.
/**
 * The mode a conversation is really in.
 *
 * A folder added to the conversation IS computer use: WorkCrew reads, writes and
 * runs commands inside it, and there is nothing else it could mean. That was set
 * once, when the folder was attached, and could drift afterwards, which left the
 * switch reading Chat with a folder sitting right below it. The engine then
 * answered with a listing it could not act on and told the user to attach the
 * folder that was already attached. Derived rather than assigned, so the two
 * cannot disagree again.
 */
export function effectiveMode(mode: ComposerMode, hasWorkingFolder: boolean): ComposerMode {
  return hasWorkingFolder ? "computer" : mode;
}

export function shouldRunOnComputer(mode: ComposerMode, text: string, inFolder = false): boolean {
  if (mode !== "computer") return false;
  return inFolder ? !isFolderQuestion(text) : !isQuestionLike(text);
}


/** Verbs that, at the start of a clause, mean the user wants something done. */
const WORK_VERB = /^(fix|change|update|add|remove|delete|rename|refactor|implement|build|create|write|install|commit|push|bump|revert|upgrade|make|move|run)\b/;

/**
 * Whether any clause in the message is an instruction.
 *
 * "What do you see in this screenshot and fix it please" opens like a question
 * and ends in a request, and the request is the part that matters. Testing for a
 * verb ANYWHERE was too loose: "why is the build failing" contains "build" as a
 * noun. A verb that OPENS a clause is how an instruction is actually spoken.
 */
export function asksForWork(text: string): boolean {
  return text
    .split(/[.?!;]+|,| and | then | also | plus /)
    .map((clause) => clause.trim())
    .some((clause) => WORK_VERB.test(clause));
}
/**
 * Whether a message typed against a working folder is really asking a question.
 *
 * Outside a folder, "can you open my email" is a question about capability. In a
 * folder it is an instruction, the same way it would be to a developer: "can you
 * add a feedback box", "please fix the build", "write a test for this" all mean
 * do it, not discuss it. Treating those as questions left the user asking three
 * times and being told each time to flip a switch.
 *
 * So only genuine information seeking stays in chat: an interrogative opener, or
 * an explicit request to be told or shown something. Everything else acts.
 */
export function isFolderQuestion(text: string): boolean {
  const t = normalized(text);
  // "What do you see in this screenshot and fix it please" opens like a question
  // and ends in an instruction. The instruction wins: a message that names work
  // to do is work, whatever word it starts with.
  if (asksForWork(t)) return false;
  return /^(how|what|whats|what's|why|when|who|where|which|is |are |was |were |do |does |did |should i|can i|could i|explain|describe|summari|tell me (about|what|how|why|which)|show me (what|how|which)|remind me)\b/.test(t);
}

// Lowercase and strip leading quotes, brackets, and stray punctuation so a typed
// `"whats in this folder` still starts with "whats" for the matchers below.
function normalized(text: string): string {
  return text.trim().toLowerCase().replace(/^["'`”“‘’([{«\s]+/, "");
}

// Whether a message reads like an instruction to act on the user's computer (drive
// the browser or a Windows app) rather than a question to answer in chat. This no
// longer routes anything on its own: it is used only to offer "Do it on my
// computer" when such a message is typed while the toggle is still on Chat.
export function looksLikeAutomation(text: string): boolean {
  const t = normalized(text);
  if (t.length < 4) return false;
  // Plainly a question, or a writing/explaining request: keep it in chat.
  if (/^(how|what|whats|what's|why|when|who|where|which|is |are |do |does |can i|can you|can u|could you|would you|explain|tell me|write|draft|compose|summari|translate|define|describe|give me|list|brainstorm|suggest|recommend|help me (write|understand|learn|decide|with)|teach me|show me how)\b/.test(t)) {
    return false;
  }
  // Explicit machine or browser context always automates.
  if (/\b(in (my|the) browser|on (my|the) (computer|pc|laptop|desktop|machine)|on my screen)\b/.test(t)) return true;
  // Imperative automation verbs at the start: the user is telling WorkCrew to act.
  if (/^(open|launch|start|go to|navigate to|visit|sign ?in|log ?in|log into|search for|download|upload|play|pause|click|fill|select|book|order|buy|reserve|post|publish|reply to|forward|organi[sz]e|tidy|sort|rename|move|copy|scroll|browse|add to cart|check out)\b/.test(t)) {
    return true;
  }
  // A known app or site paired with an action verb anywhere in the sentence.
  if (
    /\b(tiktok|youtube|gmail|outlook|excel|word|powerpoint|spotify|whatsapp|instagram|twitter|amazon|netflix|linkedin|facebook|reddit|notion|slack|discord)\b/.test(t) &&
    /\b(open|play|search|post|message|send|go|sign|log|find|watch|download|like|follow|comment)\b/.test(t)
  ) {
    return true;
  }
  // Clear coding actions (inherently imperative).
  if (/\b(clone|ffmpeg|run (the |a )?(script|command|tool))\b/.test(t)) return true;
  // git/github/repo only when paired with an action verb, so "my git is confusing"
  // stays in chat while "git pull the latest" or "set up the repo" automates.
  if (/\bgit\w*\b|\brepo\w*\b/.test(t) && /\b(clone|pull|push|commit|checkout|merge|rebase|init|fetch|set ?up|build|open|create|fix|run)\b/.test(t)) return true;
  // Media editing on a real media target near the verb (not the bare word "file").
  if (/\b(edit|crop|resize|trim|compress|rotate|convert|render|encode)\b(?:\s+\S+){0,4}\s+\b(image|images|photo|photos|picture|pictures|video|videos|clip|clips|gif)\b/.test(t)) return true;
  return false;
}

// A plain question or a writing request, as opposed to an instruction to redo a
// task. Used while iterating on an automation: a question is answered in chat,
// anything else is treated as a correction that re-runs the task.
export function isQuestionLike(text: string): boolean {
  const t = normalized(text);
  return /^(how|what|whats|what's|why|when|who|where|which|is |are |do |does |can i|can you|can u|could you|would you|explain|tell me|write|draft|compose|summari|translate|define|describe|give me|list|brainstorm|suggest|recommend|help me|teach me|show me how)\b/.test(t);
}
