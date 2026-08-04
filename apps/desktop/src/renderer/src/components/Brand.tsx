// The WorkCrew logo mark and wordmark, shared by the auth screens, the loading
// shell, and onboarding, so every surface shows the exact same brand asset.

export function LogoMark() {
  return (
    <svg className="brand-glyph" viewBox="0 0 100 100" role="img" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="wc-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="0.55" stopColor="#7c3aed" />
          <stop offset="1" stopColor="#5b21b6" />
        </linearGradient>
        <mask id="wc-plus">
          <rect width="100" height="100" fill="white" />
          <rect x="41" y="29" width="18" height="42" rx="9" fill="black" />
          <rect x="29" y="41" width="42" height="18" rx="9" fill="black" />
        </mask>
      </defs>
      <g mask="url(#wc-plus)" fill="url(#wc-grad)">
        <circle cx="50" cy="28" r="22" />
        <circle cx="50" cy="72" r="22" />
        <circle cx="28" cy="50" r="22" />
        <circle cx="72" cy="50" r="22" />
        <rect x="28" y="28" width="44" height="44" rx="14" />
      </g>
    </svg>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`} aria-label="WorkCrew">
      <span className="brand-mark"><LogoMark /></span>
      <span className="brand-name">WorkCrew</span>
    </div>
  );
}
