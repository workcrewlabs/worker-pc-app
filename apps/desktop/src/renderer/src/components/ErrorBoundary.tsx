import { Component, type ErrorInfo, type ReactNode } from "react";
import { track } from "../lib/analytics";

// A last line of defence around the whole app. Without it, any error thrown while
// React renders unmounts the entire tree and the user is left looking at an empty
// window with no explanation and nothing to click, which is indistinguishable from
// the app being broken for good. With it they get a readable message and a way
// back, and the failure is recorded instead of vanishing.
//
// Only render errors reach here; errors outside rendering are already caught by
// the window error listeners in App.
type Props = { children: ReactNode };
type State = { message: string | null };

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    const message = error instanceof Error ? error.message : "Something went wrong";
    return { message };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // Keep the detail in the console for a developer reading the log, and record
    // only a coarse, safe category as an event: never the message, which can
    // contain user content or file paths.
    console.error("WorkCrew renderer error", error, info.componentStack);
    track("app_error", { source: "desktop", category: "render" });
  }

  override render(): ReactNode {
    if (this.state.message === null) return this.props.children;
    return (
      <main className="loading-shell" role="alert">
        <h1 className="crash-title">WorkCrew hit a problem on this screen</h1>
        <p className="crash-body">
          Your account, chats and files are safe. Reloading usually fixes it. If it keeps happening, close WorkCrew
          and open it again.
        </p>
        <button className="primary" onClick={() => window.location.reload()}>Reload WorkCrew</button>
        <p className="crash-detail">{this.state.message}</p>
      </main>
    );
  }
}
