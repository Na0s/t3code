import type { ThreadId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { MenuIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { isElectron } from "../../env";
import { cn } from "~/lib/utils";
import { projectIconColorClassName } from "../../projectIconColors";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BOT_HEALTH_LABEL, BotIcon } from "./BotIcon";
import {
  botColor,
  deriveBotStack,
  IDLE_BOT_ACTIVITY,
  type Bot,
  type BotActivity,
  type BotStackCard,
} from "./BotShell.logic";

// Fading cards behind the active one, nearest first.
const STACK_CARD_CLASS = ["translate-x-2 opacity-70", "translate-x-4 opacity-40"] as const;

export function BotHeader(props: {
  readonly bots: ReadonlyArray<Bot>;
  readonly activeBot: Bot;
  readonly activityByKey: ReadonlyMap<string, BotActivity>;
  /** Under the active card: the open conversation, or what the body shows. */
  readonly subtitle: string;
  /** Hamburger and search; the medium layout moves them into the open thread list. */
  readonly showNav: boolean;
  readonly listOpen: boolean;
  readonly onToggleList: () => void;
  readonly onSearch: () => void;
  readonly onNewThread: () => void;
  readonly onSelectBot: (bot: Bot, threadId?: ThreadId) => void;
  readonly onNewBot: () => void;
}) {
  const { activeBot, activityByKey } = props;
  const gt = useGT();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const activity = (bot: Bot) => activityByKey.get(bot.key) ?? IDLE_BOT_ACTIVITY;
  const stack = deriveBotStack({ bots: props.bots, activeKey: activeBot.key, activityByKey });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- document listeners close the switcher on Escape or a click outside the header
  useEffect(() => {
    if (!switcherOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && headerRef.current?.contains(event.target)) return;
      setSwitcherOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      setSwitcherOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [switcherOpen]);

  const pick = (bot: Bot) => {
    setSwitcherOpen(false);
    props.onSelectBot(bot);
  };

  return (
    <header
      ref={headerRef}
      data-bot-header=""
      className={cn(
        "relative flex h-16 shrink-0 items-center border-b border-border px-2",
        isElectron && "drag-region",
      )}
    >
      {switcherOpen ? (
        <BotSwitcher
          bots={props.bots}
          activeKey={activeBot.key}
          activity={activity}
          onPick={pick}
          onNewBot={() => {
            setSwitcherOpen(false);
            props.onNewBot();
          }}
        />
      ) : (
        <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="flex items-center gap-0.5">
            {props.showNav ? (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={props.listOpen ? gt("Close threads") : gt("Threads")}
                  aria-expanded={props.listOpen}
                  onClick={props.onToggleList}
                >
                  {props.listOpen ? <XIcon /> : <MenuIcon />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={gt("Search threads")}
                  onClick={props.onSearch}
                >
                  <SearchIcon />
                </Button>
              </>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col items-center gap-0.5">
            <BotCardStack
              activeBot={activeBot}
              activeActivity={activity(activeBot)}
              stack={stack}
              onOpenSwitcher={() => setSwitcherOpen(true)}
              onSelectBot={props.onSelectBot}
            />
            <span className="max-w-48 truncate text-2xs text-muted-foreground">
              {props.subtitle}
            </span>
          </div>
          <div className="flex justify-end">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={gt("New conversation with {name}", {
                      name: activeBot.project.title,
                    })}
                    onClick={props.onNewThread}
                  >
                    <PlusIcon />
                  </Button>
                }
              />
              <TooltipPopup side="bottom">
                <T>New conversation</T>
              </TooltipPopup>
            </Tooltip>
          </div>
        </div>
      )}
    </header>
  );
}

function BotCardStack(props: {
  readonly activeBot: Bot;
  readonly activeActivity: BotActivity;
  readonly stack: ReadonlyArray<BotStackCard>;
  readonly onOpenSwitcher: () => void;
  readonly onSelectBot: (bot: Bot, threadId?: ThreadId) => void;
}) {
  const { activeBot } = props;
  const gt = useGT();
  const messages = useMessages();
  return (
    <div className="relative flex items-center">
      {props.stack.toReversed().map((card) => {
        const index = props.stack.indexOf(card);
        const colorClassName = projectIconColorClassName(botColor(card.bot.project));
        const label = card.attention
          ? gt("{name}: {status}", { name: card.bot.project.title, status: card.attention.label })
          : gt("{name} has unread replies", { name: card.bot.project.title });
        return (
          <Tooltip key={card.bot.key}>
            <TooltipTrigger
              render={
                card.slideOut ? (
                  <button
                    type="button"
                    aria-label={gt("Switch to {target}", { target: label })}
                    onClick={() => props.onSelectBot(card.bot, card.attention?.threadId)}
                    className={cn(
                      "absolute top-0 left-full z-0 -ml-5 flex h-full items-center rounded-r-full border border-current bg-background pr-3 pl-6 text-2xs font-medium whitespace-nowrap transition-[translate,opacity] duration-200 ease-out starting:-translate-x-6 starting:opacity-0",
                      colorClassName,
                    )}
                  >
                    {card.attention?.label}
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label={gt("Switch to {target}", { target: label })}
                    onClick={() => props.onSelectBot(card.bot)}
                    className={cn(
                      "absolute inset-0 z-0 rounded-full border border-current bg-background transition-[translate,opacity] duration-200 ease-out starting:translate-x-0 starting:opacity-0",
                      STACK_CARD_CLASS[index] ?? STACK_CARD_CLASS[1],
                      colorClassName,
                    )}
                  />
                )
              }
            />
            <TooltipPopup side="bottom">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
      <button
        type="button"
        aria-label={gt("{name}, {status}. Switch bot", {
          name: activeBot.project.title,
          status: messages(BOT_HEALTH_LABEL[props.activeActivity.health]),
        })}
        aria-haspopup="true"
        onClick={props.onOpenSwitcher}
        className="relative z-10 flex h-9 max-w-52 items-center gap-2 rounded-full border border-border bg-background py-1 pr-4 pl-1 text-sm font-medium shadow-xs/5 hover:bg-accent"
      >
        <BotIcon project={activeBot.project} health={props.activeActivity.health} />
        <span className="truncate">{activeBot.project.title}</span>
      </button>
    </div>
  );
}

function BotSwitcher(props: {
  readonly bots: ReadonlyArray<Bot>;
  readonly activeKey: string;
  readonly activity: (bot: Bot) => BotActivity;
  readonly onPick: (bot: Bot) => void;
  readonly onNewBot: () => void;
}) {
  const gt = useGT();
  const messages = useMessages();
  return (
    <div
      role="listbox"
      aria-label={gt("Bots")}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto rounded-full border border-border px-1 py-0.5"
    >
      {props.bots.map((bot) => {
        const active = bot.key === props.activeKey;
        const health = props.activity(bot).health;
        return (
          <button
            key={bot.key}
            type="button"
            role="option"
            aria-selected={active}
            aria-label={gt("{name}, {status}", {
              name: bot.project.title,
              status: messages(BOT_HEALTH_LABEL[health]),
            })}
            onClick={() => props.onPick(bot)}
            className={cn(
              "flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1 transition-[translate,opacity] duration-200 ease-out hover:bg-accent starting:-translate-x-3 starting:opacity-0",
              active && "bg-accent",
            )}
          >
            <BotIcon project={bot.project} health={health} />
            <span
              className={cn(
                "w-full truncate text-center text-3xs",
                active ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {bot.project.title}
            </span>
          </button>
        );
      })}
      <button
        type="button"
        onClick={props.onNewBot}
        className="flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-lg px-1 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span className="flex size-7 items-center justify-center rounded-full border border-dashed border-current">
          <PlusIcon className="size-3.5" />
        </span>
        <span className="w-full truncate text-center text-3xs">
          <T>New bot</T>
        </span>
      </button>
    </div>
  );
}
