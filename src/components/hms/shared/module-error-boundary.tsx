"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./ui-bits";

type Props = { children: ReactNode; label?: string };
type State = { error: Error | null };

/**
 * Module-level error boundary. A crash in ONE module (unexpected API shape, a
 * null the contract did not anticipate, a bad chunk, …) must degrade to an
 * in-page error card — never the whole-app "Application error" screen.
 *
 * The shell remounts this per route (key = module + page segments), so simply
 * navigating to another page/segment clears the error as well as Retry.
 * The fallback intentionally shows no stack trace or internal identifiers.
 */
export class ModuleErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Sanitized diagnostic only — message + first stack frames; no tokens,
    // cookies, API keys or session data are ever logged.
    console.error(
      "[module-error]",
      this.props.label ?? "module",
      error.message,
      (info.componentStack ?? "").split("\n").slice(0, 3).join(" | "),
    );
  }

  private retry = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <ErrorState
          message="This section failed to load. Please try again, or open another page from the menu."
          onRetry={this.retry}
        />
      );
    }
    return this.props.children;
  }
}
