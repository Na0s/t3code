import { type CheckpointRef } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import type { CheckpointStoreError } from "./Errors.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { UmbrellaMemberIndex } from "../vcs/UmbrellaMemberIndex.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The checkpoint this one follows, so a turn that switched branches starts where it landed. */
  readonly previousCheckpointRef?: CheckpointRef;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /** A repository, or an umbrella whose member checkouts take checkpoints even when it is a plain folder. */
    readonly hasCheckpointWorkspace: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /** Null means HEAD is unchanged or unrecorded; all changed paths then belong to the turn. */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** One repository behind a checkpoint: the workspace itself, or an umbrella member under `prefix`. */
interface CheckpointComponent {
  readonly cwd: string;
  readonly prefix: string;
}

/** Splits workspace-relative paths between the umbrella's own repository and its members. */
function routeComponentPaths(
  components: ReadonlyArray<CheckpointComponent>,
  filePaths: ReadonlyArray<string>,
): ReadonlyMap<CheckpointComponent, ReadonlyArray<string>> {
  const members = components
    .filter((component) => component.prefix !== "")
    .toSorted((left, right) => right.prefix.length - left.prefix.length);
  const routed = new Map<CheckpointComponent, string[]>(components.map((c) => [c, []]));
  for (const filePath of filePaths) {
    const member = members.find((candidate) => filePath.startsWith(candidate.prefix));
    const owner = member ?? components.find((component) => component.prefix === "");
    if (owner === undefined) continue;
    routed.get(owner)!.push(member ? filePath.slice(member.prefix.length) : filePath);
  }
  return routed;
}

/** @public */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const umbrellaMembers = yield* UmbrellaMemberIndex;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  // The registry reads an unreadable repository as none; ask Git again so that fails here.
  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = Effect.fn(
    "CheckpointStore.isGitRepository",
  )(function* (cwd) {
    if ((yield* vcsRegistry.detect({ cwd, requestedKind: "git" })) !== null) return true;
    const git = yield* vcsRegistry.get("git");
    return (yield* git.detectRepository(cwd)) !== null;
  });

  const membersOf = (cwd: string) =>
    umbrellaMembers.hasMembers()
      ? fileSystem.realPath(cwd).pipe(
          Effect.map((resolved) => umbrellaMembers.membersOf(resolved)),
          Effect.orElseSucceed(() => umbrellaMembers.membersOf(cwd)),
        )
      : Effect.succeed([]);

  // Only an umbrella pays for the extra lookups; a plain workspace is its own single component.
  const componentsOf = Effect.fn("CheckpointStore.components")(function* (cwd: string) {
    const members = yield* membersOf(cwd);
    if (members.length === 0) return null;
    const own = yield* isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));
    return [
      ...(own ? [{ cwd, prefix: "" }] : []),
      ...members.map((member) => ({ cwd: member.path, prefix: `${member.relativePath}/` })),
    ] satisfies ReadonlyArray<CheckpointComponent>;
  });

  const hasRef = (cwd: string, checkpointRef: CheckpointRef) =>
    resolveCheckpoints(cwd).pipe(
      Effect.flatMap((checkpoints) => checkpoints.hasCheckpointRef({ cwd, checkpointRef })),
      Effect.orElseSucceed(() => false),
    );

  const hasCheckpointWorkspace: CheckpointStore["Service"]["hasCheckpointWorkspace"] = Effect.fn(
    "CheckpointStore.hasCheckpointWorkspace",
  )(function* (cwd) {
    if ((yield* membersOf(cwd)).length > 0) return true;
    return yield* isGitRepository(cwd);
  });

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const components = yield* componentsOf(input.cwd);
    if (components === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.captureCheckpoint(input);
    }
    // A member that cannot be captured drops its ref, so diffs and restores leave it alone.
    yield* Effect.forEach(
      components,
      (component) =>
        resolveCheckpoints(component.cwd).pipe(
          Effect.flatMap((checkpoints) =>
            checkpoints.captureCheckpoint({ ...input, cwd: component.cwd }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("umbrella checkpoint capture failed", {
              cwd: component.cwd,
              cause,
            }).pipe(
              Effect.andThen(
                resolveCheckpoints(component.cwd).pipe(
                  Effect.flatMap((checkpoints) =>
                    checkpoints.deleteCheckpointRefs({
                      cwd: component.cwd,
                      checkpointRefs: [input.checkpointRef],
                    }),
                  ),
                  Effect.ignore,
                ),
              ),
            ),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const components = yield* componentsOf(input.cwd);
    if (components === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.hasCheckpointRef(input);
    }
    for (const component of components) {
      if (yield* hasRef(component.cwd, input.checkpointRef)) return true;
    }
    return false;
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const components = yield* componentsOf(input.cwd);
    if (components === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.restoreCheckpoint(input);
    }
    let restored = false;
    for (const component of components) {
      const checkpoints = yield* resolveCheckpoints(component.cwd);
      // Falling back to HEAD would discard a member's edits it never checkpointed.
      if (
        yield* checkpoints.restoreCheckpoint({
          cwd: component.cwd,
          checkpointRef: input.checkpointRef,
          fallbackToHead: component.prefix === "" && input.fallbackToHead === true,
        })
      ) {
        restored = true;
      }
    }
    return restored;
  });

  const diffComponent = Effect.fn("CheckpointStore.diffComponent")(function* (
    component: CheckpointComponent,
    input: DiffCheckpointsInput,
  ) {
    if (
      component.prefix !== "" &&
      !(
        (yield* hasRef(component.cwd, input.fromCheckpointRef)) &&
        (yield* hasRef(component.cwd, input.toCheckpointRef))
      )
    ) {
      return "";
    }
    const checkpoints = yield* resolveCheckpoints(component.cwd);
    return yield* checkpoints.diffCheckpoints({
      ...input,
      cwd: component.cwd,
      ...(component.prefix === "" ? {} : { pathPrefix: component.prefix }),
    });
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const components = yield* componentsOf(input.cwd);
    if (components === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.diffCheckpoints(input);
    }
    if (input.filePaths?.length === 0) return "";
    const routed =
      input.filePaths === undefined ? null : routeComponentPaths(components, input.filePaths);
    let output = "";
    for (const component of components) {
      const filePaths = routed?.get(component);
      if (filePaths !== undefined && filePaths.length === 0) continue;
      const remaining =
        input.maxOutputBytes === undefined
          ? undefined
          : input.maxOutputBytes - Buffer.byteLength(output);
      if (remaining !== undefined && remaining <= 0) break;
      output += yield* diffComponent(component, {
        ...input,
        ...(filePaths === undefined ? {} : { filePaths }),
        ...(remaining === undefined ? {} : { maxOutputBytes: remaining }),
      });
    }
    return output;
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const components = yield* componentsOf(input.cwd);
    if (components === null) {
      const checkpoints = yield* resolveCheckpoints(input.cwd);
      return yield* checkpoints.listAuthoredPaths(input);
    }
    const perComponent = yield* Effect.forEach(components, (component) =>
      Effect.gen(function* () {
        if (
          !(
            (yield* hasRef(component.cwd, input.fromCheckpointRef)) &&
            (yield* hasRef(component.cwd, input.toCheckpointRef))
          )
        ) {
          return { component, authored: new Set<string>() as ReadonlySet<string> | null };
        }
        const checkpoints = yield* resolveCheckpoints(component.cwd);
        const authored = yield* checkpoints.listAuthoredPaths({ ...input, cwd: component.cwd });
        return { component, authored };
      }),
    );
    if (perComponent.every((entry) => entry.authored === null)) return null;
    const union = new Set<string>();
    for (const { component, authored } of perComponent) {
      if (authored !== null) {
        for (const authoredPath of authored) union.add(`${component.prefix}${authoredPath}`);
        continue;
      }
      // An unchanged HEAD means every path this member changed is the turn's.
      const numstat = yield* diffComponent(component, {
        ...input,
        ignoreWhitespace: false,
        format: "numstat",
      });
      for (const file of parseTurnDiffFilesFromNumstat(numstat)) {
        union.add(file.path);
        if (file.previousPath !== undefined) union.add(file.previousPath);
      }
    }
    return union;
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const components = yield* componentsOf(input.cwd);
    for (const component of components ?? [{ cwd: input.cwd, prefix: "" }]) {
      const checkpoints = yield* resolveCheckpoints(component.cwd);
      yield* checkpoints.deleteCheckpointRefs({ ...input, cwd: component.cwd });
    }
  });

  return CheckpointStore.of({
    isGitRepository,
    hasCheckpointWorkspace,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(CheckpointStore, make);
