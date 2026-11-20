export interface FleetBotPresentation {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly color: string;
}

export function formatFleetBotMention(botId: string): string {
  return `bot:${botId}`;
}

/** Code samples and link destinations do not address a bot. */
export function collectFleetBotMentions(text: string) {
  const excluded = [
    ...text.matchAll(
      /```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)|`+[^`]*`+|\[(?:\\.|[^\]\n])*\]\([^\n]*?\)/gu,
    ),
  ];
  return [...text.matchAll(/(?<![^\s,(["'])bot:([a-zA-Z0-9_-]{1,128})(?![a-zA-Z0-9_\-/:])/gu)]
    .filter(
      (match) =>
        !excluded.some(
          (range) => match.index >= range.index && match.index < range.index + range[0].length,
        ),
    )
    .map((match) => ({
      botId: match[1]!,
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    }));
}

export function matchFleetBots<T extends FleetBotPresentation>(
  bots: ReadonlyArray<T>,
  query: string,
): T[] {
  const words = query.toLocaleLowerCase().replace(/[-:]+/gu, " ").trim().split(/\s+/u);
  return bots
    .filter((bot) => {
      const haystack =
        `${bot.id.replace(/-/gu, " ")} ${bot.name} grokbot fleet`.toLocaleLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .slice(0, 12);
}
