// Decide how a typed message is handled: answered in chat, run as an automation on
// the computer, or turned into a downloadable file. These are pure string checks,
// shared by the app shell and each conversation pane so routing is identical
// everywhere. The checks are deliberately conservative: clear questions and writing
// requests stay in chat, and only imperative "do this on my machine" phrasing
// automates.

// Lowercase and strip leading quotes, brackets, and stray punctuation so a typed
// `"whats in this folder` still starts with "whats" for the matchers below.
function normalized(text: string): string {
  return text.trim().toLowerCase().replace(/^["'`”“‘’([{«\s]+/, "");
}

// Whether a message is an instruction to act on the user's computer (drive the
// browser or a Windows app) rather than a question to answer in chat.
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

// Whether the user is asking WorkCrew to MAKE a file and hand it back to download
// (the cowork style: "make me an excel file", "create a CSV", "give me a Word
// doc"). Always a chat request: the model generates the file's content and the chat
// shows a Download button. It must never seize the computer, so a file ask is
// checked before any automation routing. Controlling an app ("open Excel and...",
// "in Excel", "on my computer") is the opposite and is left to automation.
export function looksLikeFileRequest(text: string): boolean {
  const t = normalized(text);
  if (t.length < 5) return false;
  // Controlling an app or the machine is automation, not a file hand-off.
  if (/\b(open|launch|in|inside|using|control|automate)\s+(my\s+|the\s+)?(excel|word|powerpoint|sheets?|docs?)\b/.test(t)) return false;
  if (/\b(in (my|the) browser|on (my|the) (computer|pc|laptop|desktop|machine|screen))\b/.test(t)) return false;
  // A "produce and give me" verb paired with a file or document noun.
  const wants = /\b(make|create|build|generate|produce|prepare|put together|export|draft|write|give me|send me|i (?:need|want)|can you (?:make|create|build|generate|write|prepare))\b/;
  // Specific document nouns only. Bare "file" and "table" are deliberately left
  // out: paired with "i need"/"rename"/"sort" they would steal real automation
  // requests like "rename this file" or "sort this table" into the chat path.
  const fileNoun = /\b(excel|spreadsheet|spread sheet|workbook|csv|xlsx|word (?:doc\w*|file)|docx|document|report|text file|\.txt|markdown|\.md|json file|html file)\b/;
  return wants.test(t) && fileNoun.test(t);
}
