import type { UmbrellaMember, VcsStatusResult } from "@t3tools/contracts";
import { umbrellaMemberLabel } from "@t3tools/client-runtime/state/umbrella";

interface UmbrellaDiffSection {
  /** The member's path, or null for the umbrella root. */
  readonly memberPath: string | null;
  readonly label: string;
  readonly cwd: string;
}

type MemberStatus = Pick<VcsStatusResult, "isRepo" | "hasWorkingTreeChanges" | "branchChanges">;

function memberHasChanges(status: MemberStatus | null): boolean {
  if (status === null || !status.isRepo) return false;
  const branch = status.branchChanges;
  return (
    status.hasWorkingTreeChanges ||
    (branch !== undefined && branch.insertions + branch.deletions > 0)
  );
}

/**
 * The git sections a diff panel offers for an umbrella: the root when it is a repository, then
 * each member with changes. The picked member stays listed after its changes clear, and a
 * root that is not a repository falls back to its first member so a section is always shown.
 */
export function umbrellaDiffSections(input: {
  readonly rootCwd: string;
  readonly rootLabel: string;
  readonly rootIsRepo: boolean;
  readonly members: ReadonlyArray<Pick<UmbrellaMember, "path" | "relativePath">>;
  readonly statuses: ReadonlyArray<MemberStatus | null>;
  readonly selectedMemberPath: string | null;
}): {
  readonly sections: ReadonlyArray<UmbrellaDiffSection>;
  readonly selected: UmbrellaDiffSection | null;
} {
  const toSection = (member: Pick<UmbrellaMember, "path" | "relativePath">) => ({
    memberPath: member.path,
    label: umbrellaMemberLabel(member),
    cwd: member.path,
  });
  const memberSections = input.members.flatMap((member, index) =>
    memberHasChanges(input.statuses[index] ?? null) || member.path === input.selectedMemberPath
      ? [toSection(member)]
      : [],
  );
  const root: UmbrellaDiffSection = {
    memberPath: null,
    label: input.rootLabel,
    cwd: input.rootCwd,
  };
  const firstMember = input.members[0];
  const sections = input.rootIsRepo
    ? [root, ...memberSections]
    : memberSections.length > 0 || firstMember === undefined
      ? memberSections
      : [toSection(firstMember)];
  const selected =
    sections.find((section) => section.memberPath === input.selectedMemberPath) ??
    sections[0] ??
    null;
  return { sections, selected };
}
