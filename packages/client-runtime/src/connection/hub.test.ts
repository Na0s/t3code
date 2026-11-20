import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  decodeConnectionAttemptError,
  decodePreparedConnection,
  encodeConnectionAttemptError,
  encodePreparedConnection,
} from "./hub.ts";
import { ConnectionBlockedError, RelayConnectionTarget, type PreparedConnection } from "./model.ts";

describe("HubConnection window boundary", () => {
  it("rebuilds a lease's connection and failures after a structured clone", () => {
    const prepared: PreparedConnection = {
      environmentId: EnvironmentId.make("environment-1"),
      label: "Remote",
      httpBaseUrl: "https://remote.example.test",
      socketUrl: "wss://remote.example.test/ws",
      httpAuthorization: { _tag: "Dpop", accessToken: "token", expiresAtEpochMs: 1 },
      target: new RelayConnectionTarget({
        environmentId: EnvironmentId.make("environment-1"),
        label: "Remote",
      }),
    };
    const error = new ConnectionBlockedError({ reason: "permission", detail: "No access." });

    const received = decodePreparedConnection(structuredClone(encodePreparedConnection(prepared)));
    const failure = decodeConnectionAttemptError(
      structuredClone(encodeConnectionAttemptError(error)),
    );

    expect(received).toEqual(prepared);
    expect(received.target).toBeInstanceOf(RelayConnectionTarget);
    expect(failure).toBeInstanceOf(ConnectionBlockedError);
    expect(failure.message).toBe("No access.");
  });
});
