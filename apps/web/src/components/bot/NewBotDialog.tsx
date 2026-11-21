import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { msg, T, useGT } from "gt-react";
import { useId, useRef, useState } from "react";

import { m } from "../../i18n/messages";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * Name and role for a new bot. The bot is a fresh managed project, made the way New project makes
 * one, then listed in the environment's `bots` setting.
 */
export function NewBotDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly order: number;
  readonly onCreated: (botKey: string) => void;
}) {
  const id = useId();
  const gt = useGT();
  const nameRef = useRef<HTMLInputElement>(null);
  const createProject = useAtomCommand(projectEnvironment.createNew, { reportFailure: false });
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();

  const close = (open: boolean) => {
    if (pending) return;
    props.onOpenChange(open);
    if (!open) {
      setName("");
      setRole("");
      setError(null);
    }
  };

  const submit = async () => {
    const { environmentId } = props;
    if (pending || trimmedName.length === 0 || environmentId === null) return;
    setPending(true);
    setError(null);
    const created = await createProject({ environmentId, input: { name: trimmedName } });
    if (created._tag === "Failure") {
      setPending(false);
      if (!isAtomCommandInterrupted(created)) {
        setError(
          failureMessage(squashAtomCommandFailure(created), m(msg("Could not create the bot."))),
        );
      }
      return;
    }
    const { projectId } = created.value;
    const trimmedRole = role.trim();
    const listed = await updateSettings({
      environmentId,
      input: {
        patch: {
          bots: {
            [projectId]: {
              ...(trimmedRole.length > 0 ? { role: trimmedRole } : {}),
              order: props.order,
            },
          },
        },
      },
    });
    setPending(false);
    if (listed._tag === "Failure") {
      if (!isAtomCommandInterrupted(listed)) {
        setError(
          m(
            msg("{reason} The project {name} was created; try again to list it as a bot.", {
              reason: failureMessage(
                squashAtomCommandFailure(listed),
                m(msg("Could not save the bot.")),
              ),
              name: trimmedName,
            }),
          ),
        );
      }
      return;
    }
    props.onCreated(scopedProjectKey(scopeProjectRef(environmentId, projectId)));
    close(false);
  };

  return (
    <Dialog open={props.open} onOpenChange={close}>
      <DialogPopup className="sm:max-w-sm" initialFocus={nameRef}>
        <DialogHeader>
          <DialogTitle>
            <T>New bot</T>
          </DialogTitle>
          <DialogDescription>
            <T>A bot is a persistent assistant with its own folder for guidance and memory.</T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={`${id}-form`}
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-name`}>
                <T>Name</T>
              </Label>
              <Input
                ref={nameRef}
                id={`${id}-name`}
                placeholder={gt("Atlas", { $context: "example bot name" })}
                value={name}
                autoComplete="off"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor={`${id}-role`}>
                <T context="bot role">Role</T>
              </Label>
              <Textarea
                id={`${id}-role`}
                placeholder={gt("Watches my PRs and pings me when one needs a decision.")}
                value={role}
                rows={3}
                onChange={(event) => setRole(event.target.value)}
              />
            </div>
            {props.environmentId === null ? (
              <p className="text-xs text-destructive">
                <T>Connect to a T3 server to create a bot.</T>
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </form>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={() => close(false)}>
            <T>Cancel</T>
          </Button>
          <Button
            type="submit"
            form={`${id}-form`}
            size="sm"
            disabled={pending || trimmedName.length === 0 || props.environmentId === null}
          >
            {pending ? gt("Creating…") : gt("Create bot")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
