import { ORCHESTRATION_V2_WS_METHODS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/rpc/RpcClient";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type {
  FromClientEncoded,
  FromServerEncoded,
  RequestEncoded,
  ResponseExitEncoded,
} from "effect/rpc/RpcMessage";

/**
 * How a late subscriber is brought to the shared stream's current state from
 * what the hub already received, without another subscription on the server.
 */
type ShareStrategy =
  /** Snapshot plus events carrying a sequence; `afterSequence` resumes. */
  | {
      readonly _tag: "sequenced";
      /** Payload fields that position one subscriber; they never split a shared stream. */
      readonly cursorFields: ReadonlyArray<string>;
      /** Fields that shape only the snapshot: a stored snapshot is replayed only when they match. */
      readonly snapshotFields: ReadonlyArray<string>;
      readonly snapshotSequence: (item: EncodedItem) => number | null;
      readonly eventSequence: (item: EncodedItem) => number | null;
    }
  /** Every item is the whole current state. */
  | { readonly _tag: "latest" }
  /** A snapshot item resets the state; later items change it. */
  | { readonly _tag: "snapshotLog"; readonly isSnapshot: (item: EncodedItem) => boolean }
  /** Every item since the start matters. */
  | { readonly _tag: "log" };

type EncodedItem = { readonly [key: string]: unknown };

const field = (item: EncodedItem, key: string): unknown => item[key];
const numberField = (value: unknown): number | null => (typeof value === "number" ? value : null);
const SEQUENCED_KINDS = new Set([
  "project.updated",
  "project.removed",
  "thread.updated",
  "thread.removed",
]);

const SHARED_STREAM_STRATEGIES: ReadonlyMap<string, ShareStrategy> = new Map<string, ShareStrategy>(
  [
    [
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      {
        _tag: "sequenced",
        cursorFields: [
          "afterSequence",
          "requestCompletionMarker",
          "httpSnapshotFallback",
          "knownProjectIdentities",
        ],
        snapshotFields: [],
        snapshotSequence: (item) =>
          item.kind === "snapshot"
            ? numberField((field(item, "snapshot") as EncodedItem | undefined)?.snapshotSequence)
            : null,
        eventSequence: (item) =>
          SEQUENCED_KINDS.has(String(item.kind)) ? numberField(item.sequence) : null,
      },
    ],
    [
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      {
        _tag: "sequenced",
        cursorFields: ["afterSequence", "requestCompletionMarker"],
        // The server's body deduper changes events, so `acceptDedupedBodies` stays in the key.
        snapshotFields: [
          "acceptBoundedSnapshot",
          "acceptDeferredWork",
          "acceptCompactTurnItems",
          "acceptCompactIds",
        ],
        snapshotSequence: (item) =>
          item.kind === "snapshot" ? numberField(item.snapshotSequence) : null,
        eventSequence: (item) => (item.kind === "event" ? numberField(item.sequence) : null),
      },
    ],
    [
      WS_METHODS.subscribeVcsStatus,
      { _tag: "snapshotLog", isSnapshot: (item) => item._tag === "snapshot" },
    ],
    [
      WS_METHODS.subscribeAuthAccess,
      { _tag: "snapshotLog", isSnapshot: (item) => item.type === "snapshot" },
    ],
    [
      WS_METHODS.subscribeTerminalMetadata,
      { _tag: "snapshotLog", isSnapshot: (item) => item.type === "snapshot" },
    ],
    [
      ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
      { _tag: "snapshotLog", isSnapshot: (item) => item.kind === "replace" },
    ],
    [WS_METHODS.subscribeServerLifecycle, { _tag: "log" }],
    ...[
      WS_METHODS.providerAuthSubscribe,
      WS_METHODS.providerInstallSubscribe,
      WS_METHODS.scheduledTasksSubscribe,
      WS_METHODS.subscribeDiscoveredLocalServers,
      WS_METHODS.subscribeDeviceState,
      WS_METHODS.subscribeResourceTelemetry,
      WS_METHODS.subscribeVcsBranch,
      WS_METHODS.subscribeProjectClones,
      WS_METHODS.subscribeWorktreeSetup,
      WS_METHODS.pullRequestsSubscribeRefreshes,
      WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes,
      ORCHESTRATION_V2_WS_METHODS.subscribePromptSuggestion,
    ].map((tag): [string, ShareStrategy] => [tag, { _tag: "latest" }]),
  ],
);

// Past this many retained items a late subscriber catches up on its own stream instead.
const MAX_RETAINED_ITEMS = 2_000;

function canonicalJson(value: unknown, omit: ReadonlyArray<string> = []): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const entries = Object.entries(value)
    .filter(([key, entry]) => entry !== undefined && !omit.includes(key))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

const pick = (payload: unknown, keys: ReadonlyArray<string>) =>
  canonicalJson(
    Object.fromEntries(keys.map((key) => [key, (payload as EncodedItem | null)?.[key]])),
  );

type RequestId = string | number;

interface Consumer {
  readonly clientId: number;
  readonly requestId: RequestId;
  readonly wantsMarker: boolean;
  /** Last sequence delivered; null while waiting for a snapshot (sequenced streams). */
  position: number | null;
  markerSent: boolean;
  /** A catch-up stream of its own, until it reaches what the shared stream retained. */
  privateId: string | null;
  privateSynchronized: boolean;
}

interface Group {
  readonly key: string;
  readonly strategy: ShareStrategy;
  readonly upstreamId: string;
  readonly snapshotKey: string;
  readonly consumers: Map<RequestId, Consumer>;
  // sequenced: the stream holds every event with a sequence above `floor`.
  snapshot: EncodedItem | null;
  events: Array<{ readonly sequence: number; readonly item: EncodedItem }>;
  floor: number | null;
  head: number | null;
  live: boolean;
  // latest / snapshotLog / log
  items: Array<EncodedItem>;
  complete: boolean;
}

let nextUpstreamId = 0;

/**
 * Wraps a session's protocol so every client of it (the hub's own RpcClient and
 * each relayed window) shares one server subscription per stream and arguments.
 * The first subscriber's request opens it; later ones replay what it retained and
 * then follow it; the server hears an interrupt only when the last one leaves.
 */
export const makeSharedStreamProtocol = (
  inner: RpcClient.Protocol["Service"],
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      // Every client shares one inner client; ids are unique across them in this realm.
      const innerClientId = 2_000_000_000 + nextUpstreamId++;
      const routes = new Map<RequestId, number>();
      const groups = new Map<string, Group>();
      const groupsByUpstream = new Map<string, Group>();
      const consumersByRequest = new Map<RequestId, Group>();
      const privateStreams = new Map<string, { group: Group; consumer: Consumer }>();
      const outboxes = new Map<number, { queue: Array<FromServerEncoded>; draining: boolean }>();

      // Per client, in order: a replay must not overtake or trail live items.
      const deliver = (clientId: number, message: FromServerEncoded) => {
        let outbox = outboxes.get(clientId);
        if (outbox === undefined) {
          outbox = { queue: [], draining: false };
          outboxes.set(clientId, outbox);
        }
        outbox.queue.push(message);
        if (outbox.draining) return;
        outbox.draining = true;
        const drain = outbox;
        runFork(
          Effect.gen(function* () {
            while (drain.queue.length > 0) yield* writeResponse(clientId, drain.queue.shift()!);
          }).pipe(Effect.ensuring(Effect.sync(() => (drain.draining = false)))),
        );
      };
      const deliverItems = (consumer: Consumer, items: ReadonlyArray<EncodedItem>) => {
        if (items.length === 0) return;
        deliver(consumer.clientId, {
          _tag: "Chunk",
          requestId: consumer.requestId,
          values: items as never,
        });
      };
      const sendInner = (message: FromClientEncoded) =>
        runFork(inner.send(innerClientId, message).pipe(Effect.ignore));

      const closeGroup = (group: Group) => {
        groups.delete(group.key);
        groupsByUpstream.delete(group.upstreamId);
        for (const consumer of group.consumers.values()) {
          consumersByRequest.delete(consumer.requestId);
          if (consumer.privateId !== null) {
            privateStreams.delete(consumer.privateId);
            sendInner({ _tag: "Interrupt", requestId: consumer.privateId });
          }
        }
        group.consumers.clear();
      };

      const removeConsumer = (group: Group, consumer: Consumer) => {
        group.consumers.delete(consumer.requestId);
        consumersByRequest.delete(consumer.requestId);
        if (consumer.privateId !== null) {
          privateStreams.delete(consumer.privateId);
          sendInner({ _tag: "Interrupt", requestId: consumer.privateId });
        }
        if (group.consumers.size === 0) {
          sendInner({ _tag: "Interrupt", requestId: group.upstreamId });
          closeGroup(group);
        }
      };

      const sendMarker = (consumer: Consumer) => {
        if (!consumer.wantsMarker || consumer.markerSent) return;
        consumer.markerSent = true;
        deliverItems(consumer, [{ kind: "synchronized" }]);
      };

      /** Events the stream retained after `position`, or null when it no longer holds them all. */
      const retainedAfter = (group: Group, position: number) =>
        group.floor !== null && position >= group.floor
          ? group.events.filter((event) => event.sequence > position)
          : null;

      const retainSequenced = (group: Group, sequence: number, item: EncodedItem) => {
        group.events.push({ sequence, item });
        if (group.events.length <= MAX_RETAINED_ITEMS) return;
        const dropped = group.events.shift()!;
        group.snapshot = null;
        group.floor = dropped.sequence;
      };

      const retainItem = (group: Group, item: EncodedItem) => {
        const strategy = group.strategy;
        if (strategy._tag === "latest") {
          group.items = [item];
          return;
        }
        if (strategy._tag === "snapshotLog" && strategy.isSnapshot(item)) {
          group.items = [item];
          group.complete = true;
          return;
        }
        group.items.push(item);
        if (group.items.length > MAX_RETAINED_ITEMS) {
          group.items = [];
          group.complete = false;
        }
      };

      const openPrivate = (group: Group, consumer: Consumer, request: RequestEncoded) => {
        const privateId = `shared:${innerClientId}:${nextUpstreamId++}`;
        consumer.privateId = privateId;
        consumer.privateSynchronized = false;
        privateStreams.set(privateId, { group, consumer });
        const payload = request.payload as EncodedItem;
        sendInner({
          ...request,
          id: privateId,
          payload:
            group.strategy._tag === "sequenced"
              ? { ...payload, requestCompletionMarker: true }
              : payload,
        });
      };

      /** A catch-up stream that reached the shared one hands its subscriber over. */
      const trySwitchToShared = (group: Group, consumer: Consumer) => {
        if (
          consumer.privateId === null ||
          !consumer.privateSynchronized ||
          consumer.position === null
        )
          return;
        const pending = retainedAfter(group, consumer.position);
        if (pending === null) return;
        privateStreams.delete(consumer.privateId);
        sendInner({ _tag: "Interrupt", requestId: consumer.privateId });
        consumer.privateId = null;
        deliverItems(
          consumer,
          pending.map((event) => event.item),
        );
        if (pending.length > 0) consumer.position = pending[pending.length - 1]!.sequence;
      };

      const join = (group: Group, consumer: Consumer, request: RequestEncoded) => {
        group.consumers.set(consumer.requestId, consumer);
        consumersByRequest.set(consumer.requestId, group);
        const strategy = group.strategy;
        if (strategy._tag !== "sequenced") {
          if (strategy._tag === "latest" || group.complete) {
            deliverItems(consumer, group.items);
          } else {
            openPrivate(group, consumer, request);
          }
          return;
        }
        const cursor = numberField((request.payload as EncodedItem | null)?.afterSequence);
        if (cursor !== null) {
          const pending = retainedAfter(group, cursor);
          if (pending !== null) {
            consumer.position = cursor;
            deliverItems(
              consumer,
              pending.map((event) => event.item),
            );
            if (pending.length > 0) consumer.position = pending[pending.length - 1]!.sequence;
            if (group.live) sendMarker(consumer);
            return;
          }
        }
        if (cursor === null || group.floor === null) {
          const snapshotMatches =
            pick(request.payload, strategy.snapshotFields) === group.snapshotKey;
          if (group.snapshot !== null && snapshotMatches && cursor === null) {
            consumer.position = group.head;
            deliverItems(consumer, [group.snapshot, ...group.events.map((event) => event.item)]);
            if (group.live) sendMarker(consumer);
            return;
          }
          // The shared stream has not answered yet and asked for a snapshot: wait for it.
          if (
            group.floor === null &&
            group.snapshot === null &&
            group.head === null &&
            snapshotMatches
          ) {
            return;
          }
        }
        openPrivate(group, consumer, request);
      };

      const subscribe = (clientId: number, request: RequestEncoded, strategy: ShareStrategy) => {
        const omit =
          strategy._tag === "sequenced"
            ? [...strategy.cursorFields, ...strategy.snapshotFields]
            : [];
        const key = `${request.tag}\u0000${canonicalJson(request.payload, omit)}`;
        const consumer: Consumer = {
          clientId,
          requestId: request.id,
          wantsMarker: (request.payload as EncodedItem | null)?.requestCompletionMarker === true,
          position: null,
          markerSent: false,
          privateId: null,
          privateSynchronized: false,
        };
        const existing = groups.get(key);
        if (existing !== undefined) {
          join(existing, consumer, request);
          return;
        }
        const upstreamId = `shared:${innerClientId}:${nextUpstreamId++}`;
        const cursor =
          strategy._tag === "sequenced"
            ? numberField((request.payload as EncodedItem | null)?.afterSequence)
            : null;
        const group: Group = {
          key,
          strategy,
          upstreamId,
          snapshotKey:
            strategy._tag === "sequenced" ? pick(request.payload, strategy.snapshotFields) : "",
          consumers: new Map([[consumer.requestId, consumer]]),
          snapshot: null,
          events: [],
          floor: cursor,
          head: cursor,
          live: false,
          items: [],
          complete: true,
        };
        consumer.position = cursor;
        groups.set(key, group);
        groupsByUpstream.set(upstreamId, group);
        consumersByRequest.set(consumer.requestId, group);
        const payload = request.payload as EncodedItem;
        sendInner({
          ...request,
          id: upstreamId,
          // The shared stream needs the marker to know when it is live.
          payload:
            strategy._tag === "sequenced" ? { ...payload, requestCompletionMarker: true } : payload,
        });
      };

      const onSharedItems = (group: Group, items: ReadonlyArray<EncodedItem>) => {
        const strategy = group.strategy;
        if (strategy._tag !== "sequenced") {
          for (const item of items) retainItem(group, item);
          for (const consumer of group.consumers.values()) {
            if (consumer.privateId === null) deliverItems(consumer, items);
          }
          return;
        }
        const perConsumer = new Map<Consumer, Array<EncodedItem>>();
        const push = (consumer: Consumer, item: EncodedItem) => {
          const list = perConsumer.get(consumer) ?? [];
          list.push(item);
          perConsumer.set(consumer, list);
        };
        const flush = () => {
          for (const [consumer, list] of perConsumer) deliverItems(consumer, list);
          perConsumer.clear();
        };
        for (const item of items) {
          if (item.kind === "synchronized") {
            group.live = true;
            flush();
            for (const consumer of group.consumers.values()) {
              if (consumer.privateId === null && consumer.position !== null) sendMarker(consumer);
            }
            continue;
          }
          const snapshotSequence = strategy.snapshotSequence(item);
          if (snapshotSequence !== null) {
            group.snapshot = item;
            group.events = [];
            group.floor = snapshotSequence;
            group.head = snapshotSequence;
            for (const consumer of group.consumers.values()) {
              if (consumer.privateId !== null) continue;
              push(consumer, item);
              consumer.position = snapshotSequence;
            }
            continue;
          }
          const sequence = strategy.eventSequence(item);
          if (sequence === null) {
            // `snapshot-required`: the stream ends after it.
            for (const consumer of group.consumers.values()) push(consumer, item);
            continue;
          }
          if (group.head !== null && sequence <= group.head) continue;
          group.head = sequence;
          retainSequenced(group, sequence, item);
          for (const consumer of group.consumers.values()) {
            if (consumer.privateId !== null || consumer.position === null) continue;
            if (sequence <= consumer.position) continue;
            push(consumer, item);
            consumer.position = sequence;
          }
        }
        flush();
        for (const consumer of group.consumers.values()) trySwitchToShared(group, consumer);
      };

      const onPrivateItems = (
        entry: { readonly group: Group; readonly consumer: Consumer },
        items: ReadonlyArray<EncodedItem>,
      ) => {
        const { group, consumer } = entry;
        const strategy = group.strategy;
        const forward: Array<EncodedItem> = [];
        for (const item of items) {
          if (strategy._tag === "sequenced") {
            if (item.kind === "synchronized") {
              consumer.privateSynchronized = true;
              if (consumer.wantsMarker && !consumer.markerSent) {
                consumer.markerSent = true;
                forward.push(item);
              }
              continue;
            }
            const sequence = strategy.snapshotSequence(item) ?? strategy.eventSequence(item);
            if (sequence !== null) consumer.position = sequence;
          }
          forward.push(item);
        }
        deliverItems(consumer, forward);
        trySwitchToShared(group, consumer);
      };

      let failure: RpcClientError.RpcClientError | undefined;

      const exitFor = (consumer: Consumer, exit: ResponseExitEncoded["exit"]) =>
        deliver(consumer.clientId, { _tag: "Exit", requestId: consumer.requestId, exit });

      yield* inner
        .run(innerClientId, (response) =>
          Effect.sync(() => {
            switch (response._tag) {
              case "Chunk": {
                const requestId = response.requestId;
                const group =
                  typeof requestId === "string" ? groupsByUpstream.get(requestId) : undefined;
                const privateEntry =
                  typeof requestId === "string" ? privateStreams.get(requestId) : undefined;
                if (group !== undefined || privateEntry !== undefined) {
                  sendInner({ _tag: "Ack", requestId });
                  if (group !== undefined) onSharedItems(group, response.values as never);
                  else onPrivateItems(privateEntry!, response.values as never);
                  return;
                }
                const clientId = routes.get(requestId);
                if (clientId !== undefined) deliver(clientId, response);
                return;
              }
              case "Exit": {
                const requestId = response.requestId;
                const group =
                  typeof requestId === "string" ? groupsByUpstream.get(requestId) : undefined;
                if (group !== undefined) {
                  for (const consumer of group.consumers.values()) exitFor(consumer, response.exit);
                  closeGroup(group);
                  return;
                }
                const privateEntry =
                  typeof requestId === "string" ? privateStreams.get(requestId) : undefined;
                if (privateEntry !== undefined) {
                  privateStreams.delete(requestId as string);
                  privateEntry.consumer.privateId = null;
                  exitFor(privateEntry.consumer, response.exit);
                  removeConsumer(privateEntry.group, privateEntry.consumer);
                  return;
                }
                const clientId = routes.get(requestId);
                routes.delete(requestId);
                if (clientId !== undefined) deliver(clientId, response);
                return;
              }
              case "ClientProtocolError":
              case "Defect": {
                if (response._tag === "ClientProtocolError") failure = response.error;
                routes.clear();
                for (const group of groups.values()) closeGroup(group);
                privateStreams.clear();
                for (const clientId of clientIds) deliver(clientId, response);
                return;
              }
              case "Pong":
                return;
              default:
                for (const clientId of clientIds) deliver(clientId, response);
            }
          }),
        )
        .pipe(Effect.forkScoped);

      return {
        send: (clientId, request, transferables) => {
          if (failure !== undefined) return Effect.fail(failure);
          if (request._tag === "Request") {
            const strategy = SHARED_STREAM_STRATEGIES.get(request.tag);
            if (strategy !== undefined)
              return Effect.sync(() => subscribe(clientId, request, strategy));
            routes.set(request.id, clientId);
            return inner
              .send(innerClientId, request, transferables)
              .pipe(Effect.onError(() => Effect.sync(() => routes.delete(request.id))));
          }
          if (request._tag === "Ack" || request._tag === "Interrupt") {
            const group = consumersByRequest.get(request.requestId);
            if (group !== undefined) {
              if (request._tag === "Interrupt") {
                const consumer = group.consumers.get(request.requestId);
                return Effect.sync(() => {
                  if (consumer !== undefined) removeConsumer(group, consumer);
                });
              }
              return Effect.void;
            }
            if (request._tag === "Interrupt") routes.delete(request.requestId);
          }
          return inner.send(innerClientId, request, transferables);
        },
        supportsAck: inner.supportsAck,
        supportsTransferables: inner.supportsTransferables,
        codecFor: inner.codecFor,
      };
    }),
  );
