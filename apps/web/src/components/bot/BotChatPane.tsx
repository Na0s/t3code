import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { msg, T, Var } from "gt-react";
import { useState } from "react";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { useDiffPanelStore, type ToolCallDiffTarget } from "../../diffPanelStore";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m } from "../../i18n/messages";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useRightPanelStore } from "../../rightPanelStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { toastManager } from "../ui/toast";
import type { Bot } from "./BotShell.logic";

/**
 * The selected conversation, as an embedded ChatView: the bot window has no right panel or
 * terminal drawer, so those actions open the thread in the full T3 view.
 */
export function BotChatPane(props: {
  readonly bot: Bot;
  readonly threadId: ThreadId | null;
  readonly draftId: DraftId | null;
  readonly onNewThread: () => void;
}) {
  const { bot, draftId } = props;
  const environmentId = bot.project.environmentId;
  const navigate = useNavigate();
  const draftSession = useComposerDraftStore((store) =>
    draftId === null ? null : store.getDraftSession(draftId),
  );
  const draftRedirect = useComposerDraftStore((store) =>
    draftId === null ? null : store.getPromotedDraftRedirect(draftId),
  );
  const serverThreadRef =
    draftId === null && props.threadId !== null
      ? scopeThreadRef(environmentId, props.threadId)
      : null;
  // Keeps the draft's ChatView instance through its promotion, as ThreadRouteView does.
  const [handoffKey, setHandoffKey] = useState<{ threadKey: string; key: string } | null>(null);
  const nextHandoffKey =
    draftId !== null && draftSession === null && draftRedirect
      ? handoffKey?.key === draftId
        ? handoffKey
        : { threadKey: scopedThreadKey(draftRedirect), key: draftId }
      : serverThreadRef && handoffKey?.threadKey === scopedThreadKey(serverThreadRef)
        ? handoffKey
        : null;
  if (nextHandoffKey !== handoffKey) setHandoffKey(nextHandoffKey);

  const openInT3 = (threadRef: ScopedThreadRef) => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(threadRef) });
  };
  const { copyToClipboard } = useCopyToClipboard<ScopedThreadRef>({
    target: {
      target: "command",
      unavailableMessage: msg("Clipboard API is unavailable while copying command."),
      failureMessage: msg("Failed to copy command to the clipboard."),
    },
    onCopy: (threadRef) => {
      toastManager.add({
        type: "success",
        title: m(msg("Command copied")),
        description: m(msg("The bot window has no terminal. Run it from the thread in T3.")),
        actionProps: { children: m(msg("Open in T3")), onClick: () => openInT3(threadRef) },
      });
    },
  });
  const shownThreadRef =
    serverThreadRef ??
    (draftSession ? scopeThreadRef(draftSession.environmentId, draftSession.threadId) : null) ??
    draftRedirect;
  // Stable, so shell updates that re-render this pane do not re-render ChatView.
  const openToolDiff = useStableCallback((target: ToolCallDiffTarget) => {
    const threadRef = scopeThreadRef(environmentId, target.threadId);
    useDiffPanelStore.getState().selectToolCall(threadRef, target);
    useRightPanelStore.getState().open(threadRef, "diff");
    openInT3(threadRef);
  });
  const runShellCommand = useStableCallback((command: string) => {
    if (shownThreadRef !== null) copyToClipboard(command, shownThreadRef);
  });
  // The bot window has no thread around the chat, so the shown thread hosts itself.
  const embeddedIn = (hostRef: ScopedThreadRef): SideChatParentPanel => ({
    hostRef,
    openToolDiff,
    runShellCommand,
  });

  let view: React.ReactNode = null;
  let redirect: React.ReactNode = null;
  if (draftId !== null) {
    if (draftSession) {
      view = (
        <ChatView
          key={draftId}
          draftId={draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
          embedded={embeddedIn(scopeThreadRef(draftSession.environmentId, draftSession.threadId))}
        />
      );
    } else if (draftRedirect) {
      view = (
        <ChatView
          key={draftId}
          environmentId={draftRedirect.environmentId}
          threadId={draftRedirect.threadId}
          routeKind="server"
          embedded={embeddedIn(draftRedirect)}
        />
      );
    }
    // Promoted, the draft's thread takes over its place in the URL; discarded, the bot's default does.
    if (!draftSession) {
      redirect = (
        <Navigate
          to="/bot"
          search={
            draftRedirect ? { bot: bot.key, thread: draftRedirect.threadId } : { bot: bot.key }
          }
          replace
        />
      );
    }
  } else if (serverThreadRef !== null) {
    view = (
      <ChatView
        key={nextHandoffKey?.key}
        environmentId={serverThreadRef.environmentId}
        threadId={serverThreadRef.threadId}
        routeKind="server"
        embedded={embeddedIn(serverThreadRef)}
      />
    );
  } else {
    view = (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>
            <T>No conversations yet</T>
          </EmptyTitle>
          <EmptyDescription>
            <T>
              Start one to talk with <Var>{bot.project.title}</Var>.
            </T>
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={props.onNewThread}>
            <T>New conversation</T>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    // Embedded chats key their shortcuts and focus checks to this marker.
    <div
      data-side-chat-pane={shownThreadRef?.threadId ?? ""}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {view}
      {redirect}
    </div>
  );
}
