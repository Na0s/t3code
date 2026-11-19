import { it } from "@effect/vitest";
import { ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as UmbrellaMemberIndex from "../vcs/UmbrellaMemberIndex.ts";
import * as ProjectEnrichmentService from "./ProjectEnrichmentService.ts";
import * as UmbrellaMembership from "./UmbrellaMembership.ts";

describe("umbrellaStateOf", () => {
  it.effect("offers discovered checkouts until the user turns the umbrella on", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const state = (settings: {
        readonly enabled: boolean;
        readonly adopted?: ReadonlyArray<string>;
        readonly excluded?: ReadonlyArray<string>;
        readonly enclosingRepository?: string;
      }) => {
        const { members, suggestions, enclosingRepository } = UmbrellaMembership.umbrellaStateOf({
          path,
          workspaceRoot: "/clients/acme",
          nested: ["/clients/acme/api", "/clients/acme/sites/web", "/clients/acme/legacy"],
          settings: {
            enabled: settings.enabled,
            adopted: settings.adopted ?? [],
            excluded: settings.excluded ?? [],
          },
          enclosingRepository: settings.enclosingRepository ?? null,
        });
        return {
          members: members.map((member) => `${member.relativePath}:${member.source}`),
          suggestions: suggestions.map((member) => member.relativePath),
          enclosingRepository,
        };
      };

      expect(state({ enabled: false })).toEqual({
        members: [],
        suggestions: ["api", "legacy", "sites/web"],
        enclosingRepository: null,
      });
      expect(
        state({ enabled: true, adopted: ["/work/acme-mobile", "api"], excluded: ["legacy"] }),
      ).toEqual({
        members: ["../../work/acme-mobile:adopted", "api:nested", "sites/web:nested"],
        suggestions: [],
        enclosingRepository: null,
      });
      expect(state({ enabled: true, enclosingRepository: "/clients" })).toEqual({
        members: [],
        suggestions: [],
        enclosingRepository: "/clients",
      });
    }).pipe(Effect.provide(Path.layer)),
  );
});

describe("UmbrellaMembership index", () => {
  it.effect("applies the newest settings when rebuilds overlap", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("acme");
      const root = "/clients/acme";
      const settingsFor = (excluded: ReadonlyArray<string>) =>
        ({
          projectSettingsOverrides: {
            [projectId]: { umbrellaEnabled: true, umbrellaExcludedPaths: [...excluded] },
          },
        }) as unknown as ServerSettings;
      const settings = yield* Ref.make(settingsFor([]));
      const peeks = yield* Ref.make(0);
      const firstPeekEntered = yield* Deferred.make<void>();
      const releaseFirstPeek = yield* Deferred.make<void>();
      const nested = [`${root}/api`, `${root}/web`];
      const index = UmbrellaMemberIndex.makeIndex();
      const changes = yield* PubSub.unbounded<ProjectEnrichmentService.ProjectEnrichmentChange>();
      // Startup work stays parked, so only the two rebuilds below touch the index.
      const neverActivated = yield* Deferred.make<void>();

      const membership = yield* UmbrellaMembership.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(neverActivated)),
            FileSystem.layerNoop({
              exists: () => Effect.succeed(false),
              realPath: (value) => Effect.succeed(value),
            }),
            Path.layer,
            Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
              readNestedRepositories: () => Effect.succeed(nested),
              peekNestedRepositories: () =>
                Effect.gen(function* () {
                  if ((yield* Ref.getAndUpdate(peeks, (count) => count + 1)) === 0) {
                    yield* Deferred.succeed(firstPeekEntered, undefined);
                    yield* Deferred.await(releaseFirstPeek);
                  }
                  return nested;
                }),
              subscribeChanges: PubSub.subscribe(changes),
            }),
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Ref.get(settings),
              subscribeChanges: Effect.succeed(Stream.never),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () =>
                Effect.succeed([
                  {
                    id: projectId,
                    title: "Acme",
                    workspaceRoot: root,
                    defaultModelSelection: null,
                    scripts: [],
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  },
                ]),
            }),
          ),
        ),
        Effect.provideService(UmbrellaMemberIndex.UmbrellaMemberIndex, index),
      );

      // Started immediately, an unserialized rebuild would finish before the stale one resumes.
      const stale = yield* Effect.forkChild(membership.refreshIndex, { startImmediately: true });
      yield* Deferred.await(firstPeekEntered);
      yield* Ref.set(settings, settingsFor([`${root}/web`]));
      const fresh = yield* Effect.forkChild(membership.refreshIndex, { startImmediately: true });
      yield* Deferred.succeed(releaseFirstPeek, undefined);
      yield* Fiber.join(stale);
      yield* Fiber.join(fresh);

      expect(index.membersOf(root).map((member) => member.relativePath)).toEqual(["api"]);
    }).pipe(Effect.scoped),
  );
});

describe("UmbrellaMembership changes", () => {
  it.live("names the umbrellas a root rescan or a member identity changes", () =>
    Effect.gen(function* () {
      const root = "/clients/acme";
      const shell = (id: string, workspaceRoot: string) => ({
        id: ProjectId.make(id),
        title: id,
        workspaceRoot,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      const enrichmentChanges =
        yield* PubSub.unbounded<ProjectEnrichmentService.ProjectEnrichmentChange>();
      const change = (
        workspaceRoot: string,
        kind: "identity" | "rescan",
      ): ProjectEnrichmentService.ProjectEnrichmentChange => ({
        workspaceRoot,
        enrichment: {
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: true,
        },
        repositoryIdentityResolved: kind === "identity",
        ...(kind === "rescan" ? { nestedRepositoriesResolved: true } : {}),
      });

      const membership = yield* UmbrellaMembership.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            FileSystem.layerNoop({
              exists: () => Effect.succeed(false),
              realPath: (value) => Effect.succeed(value),
            }),
            Path.layer,
            Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
              readNestedRepositories: () => Effect.succeed([`${root}/api`]),
              peekNestedRepositories: () => Effect.succeed([`${root}/api`]),
              subscribeChanges: PubSub.subscribe(enrichmentChanges),
            }),
            Layer.mock(ServerSettingsService.ServerSettingsService)({
              getSettings: Effect.succeed({
                projectSettingsOverrides: { acme: { umbrellaEnabled: true } },
              } as unknown as ServerSettings),
              subscribeChanges: Effect.succeed(Stream.never),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([shell("acme", root), shell("other", "/other")]),
            }),
          ),
        ),
        Effect.provideService(
          UmbrellaMemberIndex.UmbrellaMemberIndex,
          UmbrellaMemberIndex.makeIndex(),
        ),
      );
      const changes = yield* membership.subscribeChanges;
      const next = Stream.fromSubscription(changes).pipe(
        Stream.runHead,
        Effect.timeout(Duration.seconds(2)),
      );

      yield* PubSub.publish(enrichmentChanges, change("/other", "identity"));
      yield* PubSub.publish(enrichmentChanges, change(`${root}/api`, "identity"));
      expect(yield* next).toEqual(Option.some(["acme"]));

      yield* PubSub.publish(enrichmentChanges, change(root, "rescan"));
      expect(yield* next).toEqual(Option.some(["acme"]));
    }).pipe(Effect.scoped),
  );
});
