import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-deck-950 p-8 text-slate-100">
          <h1 className="text-3xl font-bold tracking-normal">PWS Save Auditor could not start</h1>
          <p className="mt-3 max-w-3xl text-slate-300">
            The desktop shell opened, but the frontend hit an error before the app could render.
          </p>
          <pre className="mt-5 overflow-auto rounded-md border border-red-400/30 bg-red-950/30 p-4 text-sm text-red-100">
            {this.state.error.message}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
