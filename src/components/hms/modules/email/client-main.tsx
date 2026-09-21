"use client";

// MOHD.HMS ENTERPRISE — Email client main view (§6–§9).
//
// DESKTOP (md+): 3-pane layout inside one rounded card
//   [folders 230px] | [message list 1fr] | [reading pane 1.15fr @lg+]
// MOBILE: folder chips row above the list; rows open the dedicated detail
// page via the router (no popups anywhere).
//
// HONEST STATES (no fake data, ever):
//   • no mailbox assigned → centered empty card, no Compose action
//   • SMTP not configured  → amber banner; sends stay QUEUED in the Outbox
//   • INBOX empty          → "No received email yet" + the server's real
//                            inbound-support statement
// Bootstrap (mailbox + counts + real SMTP state) refetches every 30s while
// the tab is visible.

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Mailbox as MailboxIcon } from "lucide-react";
import { api } from "@/lib/hms/api-client";
import { ErrorState, LoadingState } from "@/components/hms/shared/ui-bits";
import { navigateTo } from "@/lib/hms/router";
import { MessageList, type MessageFlag } from "./message-list";
import { FolderNav } from "./folder-nav";
import { MessageDetailView } from "./message-detail";
import type { Bootstrap } from "./types";

/** Tracks the lg breakpoint (reading pane appears at lg+ only). */
function useIsLg(): boolean {
  const [isLg, setIsLg] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setIsLg(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isLg;
}

export function MailClient({ initialFolder }: { initialFolder?: string }) {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [folder, setFolder] = useState((initialFolder ?? "INBOX").toUpperCase());
  const [search, setSearch] = useState("");
  const [flag, setFlag] = useState<MessageFlag>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const isLg = useIsLg();

  const loadBootstrap = useCallback(async () => {
    try {
      const res = await api.get<Bootstrap>("/api/v1/email/client/bootstrap");
      setBootstrap(res.data);
      setBootError(null);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : "Unable to load your mailboxes.");
    } finally {
      setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") void loadBootstrap();
    }, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadBootstrap();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadBootstrap]);

  /** Every successful child action refreshes counts + list (spec §23–§27). */
  const handleChanged = useCallback(() => {
    void loadBootstrap();
    setRefreshKey((k) => k + 1);
  }, [loadBootstrap]);

  /** Reading-pane navigation: select a thread entry, or leave the client view. */
  const handleNavigate = useCallback((seg: string[], query?: Record<string, string>) => {
    if (seg[0] === "m" && seg[1]) {
      setSelectedId(seg[1]);
      return;
    }
    setSelectedId(null);
    navigateTo("email", seg, query);
  }, []);

  const handleSelect = useCallback(
    (id: string | null) => {
      if (id === null) {
        setSelectedId(null);
        return;
      }
      if (isLg) setSelectedId(id);
      else navigateTo("email", ["m", id]);
    },
    [isLg]
  );

  if (bootLoading) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <LoadingState label="Loading your mailboxes…" rows={5} />
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="rounded-xl border bg-card p-6">
        <ErrorState message={bootError} onRetry={() => void loadBootstrap()} />
      </div>
    );
  }

  // Honest state: no mailbox assigned — no inbox, no compose (§28).
  if (!bootstrap || bootstrap.mailboxes.length === 0) {
    return (
      <div className="flex min-h-[420px] items-center justify-center rounded-xl border bg-card p-6">
        <div className="flex max-w-md flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <MailboxIcon className="h-6 w-6 text-muted-foreground" aria-hidden />
          </div>
          <h2 className="mt-4 text-lg font-semibold">No mailbox assigned</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Your account has no corporate mailbox yet. An administrator assigns mailboxes in Email
            Configuration.
          </p>
        </div>
      </div>
    );
  }

  const smtpConfigured = bootstrap.smtp.configured;

  return (
    <div className="space-y-3">
      {!smtpConfigured ? (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden />
          <p>
            <span className="font-medium">Outgoing mail server is not configured yet</span> — emails
            you send will stay QUEUED in the Outbox until an administrator completes Email
            Configuration.
          </p>
        </div>
      ) : null}

      {/* Mobile: horizontal folder chips above the list */}
      <div className="md:hidden">
        <FolderNav
          bootstrap={bootstrap}
          activeFolder={folder}
          onFolderChange={(f) => {
            setFolder(f);
            setSelectedId(null);
          }}
          variant="chips"
        />
      </div>

      <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <div className="grid h-[calc(100vh-13rem)] min-h-[480px] gap-0 divide-x md:grid-cols-[230px_minmax(0,1fr)] lg:grid-cols-[230px_minmax(0,1fr)_minmax(0,1.15fr)]">
          <aside className="hidden flex-col overflow-y-auto p-3 md:flex">
            <FolderNav
              bootstrap={bootstrap}
              activeFolder={folder}
              onFolderChange={(f) => {
                setFolder(f);
                setSelectedId(null);
              }}
              variant="sidebar"
            />
          </aside>

          <section aria-label="Message list" className="flex min-h-0 min-w-0 flex-col">
            <MessageList
              folder={folder}
              search={search}
              onSearchChange={setSearch}
              flag={flag}
              onFlagChange={setFlag}
              bootstrap={bootstrap}
              selectedId={selectedId}
              onSelect={handleSelect}
              onChanged={handleChanged}
              refreshKey={refreshKey}
            />
          </section>

          {/* Reading pane — lg+ only; mobile/deep links use the full page */}
          {isLg ? (
            <section aria-label="Reading pane" className="min-w-0 overflow-y-auto">
              {selectedId ? (
                <MessageDetailView
                  key={selectedId}
                  messageId={selectedId}
                  onChanged={handleChanged}
                  onNavigate={handleNavigate}
                />
              ) : (
                <div className="flex h-full flex-col items-center justify-center px-6 text-center">
                  <MailboxIcon className="h-8 w-8 text-muted-foreground/40" aria-hidden />
                  <p className="mt-3 text-sm font-medium">Select an email to read</p>
                  <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                    Choose a message from the list — replies, forwarding and organizing happen right
                    here.
                  </p>
                </div>
              )}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
