import { useState } from "react";
import { setOnboarding } from "../lib/storage";
import { Brand } from "./Brand";
import { Dropdown } from "./Dropdown";

// Icons for the onboarding cards, matching the app's icon language (24 viewBox,
// stroke 2, rounded caps). Each info bullet and starter prompt leads with one,
// like the reference onboarding.
function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.4-3 8.4-7 10-4-1.6-7-5.6-7-10V6z" />
      <path d="M9.2 12l2 2 3.6-3.8" />
    </svg>
  );
}
function LockRoundIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}
function SheetIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M4 10h16M10 10v10" />
    </svg>
  );
}
function PenIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20l1.2-4.2L16.4 4.6a2.1 2.1 0 0 1 3 3L8.2 18.8z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  );
}
function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 12a8 8 0 0 1-8 8H5.5L4 21.5V12a8 8 0 1 1 16 0z" />
    </svg>
  );
}
function FolderGlyphIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function BoltGlyphIcon() {
  return (
    <svg viewBox="0 0 24 24" width="19" height="19" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z" />
    </svg>
  );
}

// Pick a leading icon for a starter prompt from what it is about.
function promptIcon(prompt: string) {
  if (/excel|spreadsheet|tracker|gradebook|budget|schedule/i.test(prompt)) return <SheetIcon />;
  if (/write|draft|edit|message|email|letter|pitch|title|post/i.test(prompt)) return <PenIcon />;
  return <ListIcon />;
}

// The first-run flow, modeled on the Claude onboarding: a short "before your
// first chat" screen, the user's name, what kind of work they do, and three
// starter prompts tailored to that role. Shown once per install, over the
// workspace. On the web build an extra first step pushes the desktop download
// (see the `showDownloadStep` prop); the desktop app skips it.

const ROLES = [
  "Business owner",
  "Founder",
  "Sales",
  "Marketing",
  "Finance",
  "Software engineer",
  "Student",
  "Writer",
  "Educator",
  "Consultant",
  "Researcher",
  "Healthcare",
  "Legal",
  "Other"
] as const;

// Three starter prompts per role. Every prompt works in plain chat (no
// automation needed), so the very first experience always succeeds, and most
// show off the file skills (Excel and documents) that set WorkCrew apart.
const ROLE_PROMPTS: Record<string, string[]> = {
  "Business owner": [
    "Make me an Excel template to track my monthly income and expenses",
    "Write a friendly follow-up message I can send to customers who went quiet",
    "Help me plan next week: I will tell you my tasks and you organize them"
  ],
  Founder: [
    "Make me an Excel financial projection template for a small startup",
    "Help me write a short, clear pitch for my product",
    "Draft a simple one-page business plan outline I can fill in"
  ],
  Sales: [
    "Make me an Excel pipeline tracker with stages and totals",
    "Write a cold outreach message that does not sound pushy",
    "Help me prepare talking points for a sales call"
  ],
  Marketing: [
    "Draft five social media post ideas for my product",
    "Make me an Excel content calendar for the next month",
    "Write a short email campaign with a subject line and body"
  ],
  Finance: [
    "Make me an Excel budget with formulas for totals and percentages",
    "Explain a financial concept to me in plain language",
    "Build me an Excel cash flow tracker with a monthly summary"
  ],
  "Software engineer": [
    "Explain a code pattern or concept I give you",
    "Help me debug an error message I paste in",
    "Review a function I paste and suggest improvements"
  ],
  Student: [
    "Turn my notes into a clean study summary",
    "Make me an Excel study schedule for my exams",
    "Explain a difficult concept to me step by step"
  ],
  Writer: [
    "Help me outline an article from a rough idea",
    "Edit a paragraph I paste in and make it flow better",
    "Brainstorm ten title options for my piece"
  ],
  Educator: [
    "Draft a lesson plan for a topic I give you",
    "Make me an Excel gradebook with averages",
    "Write a clear explanation of a topic for my students"
  ],
  Consultant: [
    "Turn my rough notes into a client-ready summary",
    "Make me an Excel project tracker with status and owners",
    "Draft a professional proposal outline"
  ],
  Researcher: [
    "Summarize a text I paste into key findings",
    "Make me an Excel sheet to organize my sources",
    "Help me structure a literature review outline"
  ],
  Healthcare: [
    "Make me an Excel staff schedule template",
    "Summarize a document I paste in into plain language",
    "Draft a clear patient information sheet on a topic I give you"
  ],
  Legal: [
    "Summarize a document I paste in into plain language",
    "Draft a professional letter from points I give you",
    "Make me an Excel matter tracker with deadlines"
  ],
  Other: [
    "Make me an Excel file to organize something I describe",
    "Help me write a professional email from a few bullet points",
    "Summarize a long text I paste in"
  ]
};

type Step = "download" | "before" | "name" | "role" | "prompts";

export function OnboardingFlow({
  userName,
  onSetName,
  onDone,
  showDownloadStep = false,
  onDownload
}: {
  userName: string | null;
  onSetName: (name: string) => Promise<void>;
  onDone: (starter: string) => void;
  // Web build only: lead with the "best on desktop" download push.
  showDownloadStep?: boolean;
  onDownload?: () => void;
}) {
  const [step, setStep] = useState<Step>(showDownloadStep ? "download" : "before");
  const [name, setName] = useState(userName ?? "");
  const [role, setRole] = useState("");

  function finish(starter: string) {
    setOnboarding({ done: true, name: name.trim() || undefined, role: role || undefined, starter: starter || undefined });
    onDone(starter);
  }

  async function submitName() {
    const trimmed = name.trim();
    if (trimmed.length > 0 && trimmed !== userName) {
      try { await onSetName(trimmed); } catch { /* keep going; the name is still stored locally */ }
    }
    setStep("role");
  }

  const prompts = ROLE_PROMPTS[role] ?? ROLE_PROMPTS.Other!;

  return (
    <main className="ob-shell">
      <div className="ob-brand"><Brand compact /></div>

      {step === "download" && (
        <section className="ob-inner ob-wide">
          <h1 className="ob-title">Get the most out of WorkCrew on your desktop</h1>
          <p className="ob-sub">With the desktop app, WorkCrew can work in your files and folders, build Excel files on your disk, and automate your apps and browser while you focus on other work.</p>
          <div className="ob-columns">
            <div className="ob-column">
              <span className="ob-tag">For thinking</span>
              <div className="ob-column-head"><span className="ob-icon-chip"><ChatIcon /></span><h3>Chat</h3></div>
              <p>Ask questions, brainstorm, and create documents and Excel files.</p>
              <strong>No setup required</strong>
            </div>
            <div className="ob-column">
              <span className="ob-tag">For real work</span>
              <div className="ob-column-head"><span className="ob-icon-chip"><FolderGlyphIcon /></span><h3>Folders</h3></div>
              <p>Work inside your own folders: read, edit, and build files in place.</p>
              <strong>Best on desktop</strong>
            </div>
            <div className="ob-column">
              <span className="ob-tag">For hands-off</span>
              <div className="ob-column-head"><span className="ob-icon-chip"><BoltGlyphIcon /></span><h3>Automations</h3></div>
              <p>Record tasks once, then let WorkCrew drive your apps and browser.</p>
              <strong>Best on desktop</strong>
            </div>
          </div>
          <button className="ob-primary" type="button" onClick={onDownload}>Download for Windows</button>
          <button className="ob-link" type="button" onClick={() => setStep("before")}>Skip</button>
        </section>
      )}

      {step === "before" && (
        <section className="ob-inner">
          <h1 className="ob-title">Before your first chat</h1>
          <p className="ob-sub">A few things to know</p>
          <div className="ob-card">
            <div className="ob-bullet">
              <span className="ob-bullet-icon"><ShieldIcon /></span>
              <p><strong>You stay in control:</strong> WorkCrew asks before it runs anything on your computer, and you can stop it at any time.</p>
            </div>
            <div className="ob-bullet">
              <span className="ob-bullet-icon"><LockRoundIcon /></span>
              <p><strong>Private by design:</strong> your files are read locally and your chats are never sold or used for ads.</p>
            </div>
            <div className="ob-bullet">
              <span className="ob-bullet-icon"><SheetIcon /></span>
              <p><strong>Built for real work:</strong> WorkCrew creates real files, real spreadsheets, and real automations, not just answers.</p>
            </div>
          </div>
          <button className="ob-primary" type="button" onClick={() => setStep("name")}>Continue</button>
        </section>
      )}

      {step === "name" && (
        <section className="ob-inner">
          <h1 className="ob-title">What&rsquo;s your name?</h1>
          <p className="ob-sub">So WorkCrew knows what to call you.</p>
          <input
            className="ob-input"
            value={name}
            placeholder="Enter your name"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submitName(); }}
            autoFocus
          />
          <button className="ob-primary" type="button" disabled={name.trim().length === 0} onClick={() => void submitName()}>Continue</button>
        </section>
      )}

      {step === "role" && (
        <section className="ob-inner">
          <h1 className="ob-title">What kind of work do you do?</h1>
          <p className="ob-sub">Pick a role so WorkCrew can tailor your experience.</p>
          {/* The native select popup is drawn by Windows: it ignores the field's
              padding, so its labels land off-centre and its chevron sits flush
              against the border. The app's own dropdown is used instead, which
              styles and centres both the trigger and the list. */}
          <div className="ob-select-wrap">
            <Dropdown
              value={role}
              options={ROLES.map((entry) => ({ value: entry, label: entry }))}
              onChange={setRole}
              ariaLabel="Select your role"
              placeholder="Select your role"
            />
          </div>
          {role && <button className="ob-primary" type="button" onClick={() => setStep("prompts")}>Continue</button>}
          <button className="ob-link" type="button" onClick={() => finish("")}>Set up later</button>
        </section>
      )}

      {step === "prompts" && (
        <section className="ob-inner">
          <h1 className="ob-title">Where should we start{name.trim() ? `, ${name.trim().split(/\s+/)[0]}` : ""}?</h1>
          <p className="ob-sub">Pick one to try, or start with your own topic.</p>
          <div className="ob-prompts">
            {prompts.map((prompt) => (
              <button key={prompt} className="ob-prompt" type="button" onClick={() => finish(prompt)}>
                <span className="ob-prompt-icon">{promptIcon(prompt)}</span>
                <span>{prompt}</span>
              </button>
            ))}
          </div>
          <button className="ob-link" type="button" onClick={() => finish("")}>I have my own topic</button>
        </section>
      )}
    </main>
  );
}
