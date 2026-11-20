import type {
  DesktopWindowCloseDecision,
  DesktopWindowCloseRequest,
  DesktopWindowsBridge,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { desktopWindowsBridge } from "../windowContext";
import { notifyWindowActionFailure } from "./windowActions";
import { normalizeWindowProfileName, WINDOW_PROFILE_NAME_MAX_LENGTH } from "./windowProfiles.logic";

/** The save-on-close prompt, once per desktop window. */
export function DesktopWindowsHost() {
  const [bridge] = useState(desktopWindowsBridge);
  return bridge === null ? null : <DesktopWindowsHostContent bridge={bridge} />;
}

function DesktopWindowsHostContent({ bridge }: { readonly bridge: DesktopWindowsBridge }) {
  const [request, setRequest] = useState<DesktopWindowCloseRequest | null>(null);
  const [name, setName] = useState("");
  const pendingRequestIdRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop shell's close requests
  useEffect(
    () =>
      bridge.onCloseRequest((next) => {
        const previous = pendingRequestIdRef.current;
        // A newer request supersedes one still on screen; the shell waits on every request.
        if (previous !== null && previous !== next.requestId) {
          void bridge.resolveCloseRequest(previous, { action: "cancel" }).catch(() => {});
        }
        pendingRequestIdRef.current = next.requestId;
        setRequest(next);
        setName(next.suggestedName);
      }),
    [bridge],
  );

  const resolve = (decision: DesktopWindowCloseDecision) => {
    if (request === null) return;
    pendingRequestIdRef.current = null;
    setRequest(null);
    bridge.resolveCloseRequest(request.requestId, decision).catch((cause: unknown) => {
      notifyWindowActionFailure("Couldn't close the window", cause);
    });
  };
  const savedName = normalizeWindowProfileName(name);
  // Without a usable name, Save leaves the prompt open.
  const save = () => {
    if (savedName !== null) resolve({ action: "save", name: savedName });
  };

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) resolve({ action: "cancel" });
      }}
    >
      <DialogPopup className="max-w-md" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>Save this window?</DialogTitle>
          <DialogDescription>
            A saved window keeps its project filter and theme. Reopen it from the command palette or
            Settings.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            aria-label="Window name"
            maxLength={WINDOW_PROFILE_NAME_MAX_LENGTH}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              save();
            }}
          />
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => resolve({ action: "cancel" })}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => resolve({ action: "discard" })}
          >
            Don't Save
          </Button>
          <Button type="button" size="sm" disabled={savedName === null} onClick={save}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
