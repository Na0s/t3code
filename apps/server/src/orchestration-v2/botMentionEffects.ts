import type { CommandId, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { referencedBotMentions } from "@t3tools/shared/composerContextReferences";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

/**
 * One delivery per user message and tagged bot. Its id makes a command retry, or a later update
 * of the same message, enqueue nothing new.
 */
export function botMentionDeliveryEffects(
  commandId: CommandId,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
): PendingOrchestrationEffectV2[] {
  const effects = new Map<string, PendingOrchestrationEffectV2>();
  for (const event of events) {
    if (event.type !== "message.updated") continue;
    const message = event.payload;
    if (message.role !== "user" || message.context === undefined) continue;
    for (const bot of referencedBotMentions(message.text, message.context.records)) {
      const id = `effect:bot-mention.deliver:${message.id}:${bot.projectId}`;
      effects.set(id, {
        id,
        commandId,
        threadId: message.threadId,
        request: { type: "bot-mention.deliver", messageId: message.id, projectId: bot.projectId },
      });
    }
  }
  return [...effects.values()];
}
