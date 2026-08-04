import { DESKTOP_DOWNLOAD_URL } from "../lib/platform";

// Shown on the web app when the user tries a desktop-only feature (recording,
// browser or computer automations, working in a folder): the feature stays
// visible so people discover it, and this modal sends them to install the
// desktop app, like Claude's web version does.
export function DownloadGateModal({ feature, onClose }: { feature: string; onClose: () => void }) {
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <section
        className="modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="download-gate-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="modal-badge">Desktop app</span>
        <h2 id="download-gate-title">{feature} needs the desktop app</h2>
        <p className="modal-text">
          The web version of WorkCrew handles chat, documents, and Excel files. To record tasks and let WorkCrew
          work your apps, browser, and folders, install the free desktop app; it takes about a minute.
        </p>
        <div className="modal-buttons">
          <button className="secondary" onClick={onClose}>Not now</button>
          <button className="primary" onClick={() => { window.open(DESKTOP_DOWNLOAD_URL, "_blank"); onClose(); }}>
            Download for Windows
          </button>
        </div>
      </section>
    </div>
  );
}
