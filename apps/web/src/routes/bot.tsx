import { createFileRoute, redirect } from "@tanstack/react-router";

import { BotShell } from "../components/bot/BotShell";
import { validateBotRouteSearch } from "../components/bot/BotShell.logic";

// Outside `_chat`: the bot window has its own thread list and header, and the root leaves out the main sidebar.
export const Route = createFileRoute("/bot")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  validateSearch: validateBotRouteSearch,
  component: BotRouteView,
});

function BotRouteView() {
  return <BotShell search={Route.useSearch()} />;
}
