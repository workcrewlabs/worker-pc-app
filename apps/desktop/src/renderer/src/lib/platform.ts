// Which build this renderer is running in. The web build (vite.web.config.ts)
// defines VITE_WORKCREW_WEB=1; the Electron renderer does not, so desktop-only
// UI (recorder, automations, folders) can gate itself with one check. Kept in
// its own module so both bundles can import it without pulling anything heavy.
export const isWebBuild = import.meta.env.VITE_WORKCREW_WEB === "1";

// Where the web app sends people to install the desktop app.
export const DESKTOP_DOWNLOAD_URL = "https://getworkcrew.com/#download";
