import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import type { FromClientEncoded, FromServerEncoded, RequestEncoded } from "effect/rpc/RpcMessage";
import * as RpcSerialization from "effect/rpc/RpcSerialization";

/**
 * One end of a message channel carrying encoded RPC messages, such as a DOM
 * `MessagePort` between two windows. Messages are plain JSON-compatible values.
 */
export interface RpcPort {
  readonly postMessage: (message: unknown) => void;
  readonly onMessage: (listener: (message: unknown) => void) => () => void;
  readonly close: () => void;
}

/** Sent by the relay instead of forwarding a transport failure, then the port closes. */
export interface RelayClosedMessage {
  readonly _tag: "RelayClosed";
  readonly detail: string;
}

const isRelayClosedMessage = (message: unknown): message is RelayClosedMessage =>
  typeof message === "object" &&
  message !== null &&
  (message as { readonly _tag?: unknown })._tag === "RelayClosed";

/**
 * A stream the relay serves from state the hub already holds instead of
 * opening another subscription on the server. `encode` turns a chunk of
 * `items` into the RPC's encoded chunk values.
 */
export interface SharedRelayStream {
  readonly tag: string;
  readonly matches: (payload: unknown) => boolean;
  readonly items: Stream.Stream<unknown>;
  readonly encode: (values: ReadonlyArray<unknown>) => Effect.Effect<unknown>;
}

/** Runs port messages one at a time and in arrival order, like a socket's frames. */
const makeSerialRunner = <A>(
  runFork: (effect: Effect.Effect<void>) => unknown,
  handle: (message: A) => Effect.Effect<void>,
) => {
  const queue: Array<A> = [];
  let draining = false;
  const drain = Effect.gen(function* () {
    while (queue.length > 0) {
      yield* handle(queue.shift()!);
    }
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        draining = false;
      }),
    ),
  );
  return (message: A) => {
    queue.push(message);
    if (draining) return;
    draining = true;
    runFork(drain);
  };
};

// RpcClient numbers its clients from 0 within one JavaScript realm, so relay
// clients sharing the hub's protocol start far above any realistic count.
let nextRelayClientId = 1_000_000_000;

/**
 * Serves a secondary window's RpcClient over `port` through the hub's socket.
 * Request ids are renamed on the way in and restored on the way out: each
 * window numbers requests from its own counter, and the server keys them per socket.
 */
export const serveRelay = Effect.fnUntraced(function* (options: {
  readonly protocol: RpcClient.Protocol["Service"];
  readonly port: RpcPort;
  readonly shared?: ReadonlyArray<SharedRelayStream>;
}): Effect.fn.Return<void, never, Scope.Scope> {
  const { protocol, port } = options;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const clientId = nextRelayClientId++;
  const prefix = `relay${clientId}:`;
  // Hub id -> the secondary's original id, whose type the secondary's client keys on.
  const forwarded = new Map<string, string | number>();
  const sharedFibers = new Map<string | number, Fiber.Fiber<void, never>>();
  let closed = false;

  const toHubId = (id: string | number) => `${prefix}${String(id)}`;

  // The port itself closes with the scope: closing right after the last post could drop it.
  const close = (detail: string) =>
    Effect.sync(() => {
      if (closed) return;
      closed = true;
      try {
        port.postMessage({ _tag: "RelayClosed", detail } satisfies RelayClosedMessage);
      } catch {}
    });

  const post = (message: FromServerEncoded) =>
    Effect.sync(() => {
      if (!closed) port.postMessage(message);
    });

  const restore = (requestId: string | number) =>
    typeof requestId === "string" ? forwarded.get(requestId) : undefined;

  yield* protocol
    .run(clientId, (response) => {
      switch (response._tag) {
        case "Chunk":
        case "Exit": {
          const original = restore(response.requestId);
          if (original === undefined) return Effect.void;
          if (response._tag === "Exit") forwarded.delete(String(response.requestId));
          return post({ ...response, requestId: original });
        }
        case "ClientProtocolError":
          return close(response.error.message);
        case "Pong":
          return Effect.void;
        default:
          return post(response);
      }
    })
    .pipe(Effect.forkScoped);

  const serveShared = (shared: SharedRelayStream, request: RequestEncoded) => {
    const fiber = shared.items.pipe(
      Stream.runForEachArray((values) =>
        values.length === 0
          ? Effect.void
          : shared
              .encode(values)
              .pipe(
                Effect.flatMap((encoded) =>
                  post({ _tag: "Chunk", requestId: request.id, values: encoded as never }),
                ),
              ),
      ),
      // Shared streams outlive any one subscriber, so their end means the hub's session ended.
      Effect.matchCauseEffect({
        onSuccess: () => close("The main window's shared subscription ended."),
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : close("The main window's shared subscription failed."),
      }),
      Effect.ensuring(Effect.sync(() => sharedFibers.delete(request.id))),
    );
    sharedFibers.set(request.id, runFork(fiber));
  };

  const handle = (message: FromClientEncoded): Effect.Effect<void> => {
    switch (message._tag) {
      case "Request": {
        const shared = options.shared?.find(
          (candidate) => candidate.tag === message.tag && candidate.matches(message.payload),
        );
        if (shared !== undefined) {
          serveShared(shared, message);
          return Effect.void;
        }
        const hubId = toHubId(message.id);
        forwarded.set(hubId, message.id);
        return protocol.send(clientId, { ...message, id: hubId }).pipe(
          Effect.catch((error: RpcClientError.RpcClientError) => {
            forwarded.delete(hubId);
            return close(error.message);
          }),
        );
      }
      case "Ack":
      case "Interrupt": {
        const fiber = sharedFibers.get(message.requestId);
        if (fiber !== undefined) {
          return message._tag === "Interrupt" ? Fiber.interrupt(fiber) : Effect.void;
        }
        const hubId = toHubId(message.requestId);
        if (!forwarded.has(hubId)) return Effect.void;
        if (message._tag === "Interrupt") forwarded.delete(hubId);
        return protocol
          .send(clientId, { ...message, requestId: hubId })
          .pipe(Effect.catch((error) => close(error.message)));
      }
      default:
        return Effect.void;
    }
  };

  const enqueue = makeSerialRunner(runFork, handle);
  const stopListening = port.onMessage((message) => {
    if (!closed) enqueue(message as FromClientEncoded);
  });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      stopListening();
      for (const fiber of sharedFibers.values()) yield* Fiber.interrupt(fiber);
      // The server keeps streaming to an abandoned id until it hears an interrupt.
      for (const hubId of forwarded.keys()) {
        yield* protocol.send(clientId, { _tag: "Interrupt", requestId: hubId }).pipe(Effect.ignore);
      }
      forwarded.clear();
      yield* close("The main window closed this connection.");
      port.close();
    }),
  );
});

/**
 * The secondary window's end: an RpcClient protocol whose requests travel over
 * `port` to a relay in the hub. `onClosed` runs once when the relay goes away.
 */
export const makePortProtocol = (options: {
  readonly port: RpcPort;
  readonly onMessage?: () => void;
  readonly onClosed: (detail: string) => Effect.Effect<void>;
}): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse, clientIds) {
      const { port } = options;
      const runFork = Effect.runForkWith(yield* Effect.context<never>());
      const requestClients = new Map<string | number, number>();
      let closedError: RpcClientError.RpcClientError | undefined;

      const broadcast = (response: FromServerEncoded) =>
        Effect.forEach(Array.from(clientIds), (clientId) => writeResponse(clientId, response), {
          discard: true,
        });

      const fail = (detail: string) =>
        Effect.suspend(() => {
          if (closedError !== undefined) return Effect.void;
          closedError = new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({ message: detail, cause: undefined }),
          });
          requestClients.clear();
          return broadcast({ _tag: "ClientProtocolError", error: closedError }).pipe(
            Effect.uninterruptible,
            Effect.andThen(options.onClosed(detail)),
          );
        });

      const receive = (message: unknown): Effect.Effect<void> => {
        if (isRelayClosedMessage(message)) return fail(message.detail);
        const response = message as FromServerEncoded;
        if ("requestId" in response) {
          const clientId = requestClients.get(response.requestId);
          if (clientId === undefined) return Effect.void;
          if (response._tag === "Exit") requestClients.delete(response.requestId);
          return writeResponse(clientId, response);
        }
        return broadcast(response);
      };

      const enqueue = makeSerialRunner(runFork, receive);
      const stopListening = port.onMessage((message) => {
        options.onMessage?.();
        enqueue(message);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stopListening();
          port.close();
        }),
      );

      return {
        send: (_clientId, request) => {
          if (closedError !== undefined) return Effect.fail(closedError);
          switch (request._tag) {
            case "Request":
              requestClients.set(request.id, _clientId);
              break;
            case "Interrupt":
              requestClients.delete(request.requestId);
              break;
            case "Ping":
            case "Eof":
              return Effect.void;
          }
          return Effect.sync(() => port.postMessage(request));
        },
        supportsAck: true,
        supportsTransferables: false,
        codecFor: RpcSerialization.json.codecFor,
      };
    }),
  );
