/**
 * Master-plan ↔ child-plan reconciliation.
 *
 * Two records of the same fact, written by different mechanisms: a child's
 * `Status:` (spec-verify, on that child) and the master's `- [x] … VERIFIED`
 * (spec-master-execute, from what a worker *reported*). Drift in either
 * direction is a finding.
 *
 * ⛔ Children are resolved by the `Parent:` back-link, NOT by globbing
 * `<master-slug>-phase-*.md`; the glob is only a SECOND pass that surfaces
 * phase-named files carrying no link (e.g. `…-phase-1-spike.md`).
 *
 * ⛔ Direct-fs only. Never route this through the sidecar or derive it from
 * `store`: MCP tools receive `store: null` in production whenever the sidecar
 * runs, so the audit would pass every test and do nothing in the field.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parsePlanFile, slugFromFilename } from "./parser.js";
import { markFencedLines } from "./parser-fences.js";
import {
  findMasterWorkspace,
  readRawStatus,
  resolveForeignChild,
  type ForeignFindingKind,
} from "./master-audit-foreign.js";
import type { SpecStatus } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A `- [x] Phase N: Title (Wave M) — STATUS` row in `## Progress Tracking`. */
export interface MasterCheckbox {
  phase: number;
  checked: boolean;
  label: string;
  /** Trailing status claim (`— **VERIFIED**`), if the row carries one. */
  declaredStatus?: string;
  /** 0-based line index within the master plan. */
  line: number;
}

export interface ChildPlan {
  slug: string;
  planFile: string;
  status: SpecStatus;
  /** Raw `Status:` text, before normalisation collapses unknowns to PENDING. */
  rawStatus?: string;
  wave?: number;
  /** Phase number derived from the slug suffix, when it has one. */
  phase?: number;
  /** Foreign child (`Repo:`): the resolved repo directory. */
  repo?: string;
  /** Foreign child: the resolved `Location:` plan its status was read from. */
  location?: string;
}

export interface OrphanPlan {
  slug: string;
  planFile: string;
  rawStatus?: string;
}

export type FindingKind =
  | "not-verified"
  | "checkbox-disagrees"
  | "orphan"
  | "missing-child"
  | "no-children"
  | ForeignFindingKind;

export interface MasterAuditFinding {
  kind: FindingKind;
  slug: string;
  message: string;
  childStatus?: SpecStatus;
  checkboxChecked?: boolean;
  declaredStatus?: string;
}

/**
 * A VERIFIED child with no `<slug>.spec-review.json` beside it: its worker
 * probably skipped /spec's code review. Non-blocking — older children were
 * verified before review files existed, and the review is optional when
 * `SENTINAL_SPEC_REVIEWER_ENABLED=false`.
 */
export interface MasterAuditWarning {
  kind: "no-review-evidence";
  slug: string;
  message: string;
}

export interface MasterAuditResult {
  ok: boolean;
  master: { slug: string; planFile: string; status: SpecStatus; title: string };
  children: ChildPlan[];
  /** Phase-named files carrying no `Parent:` link back to this master. */
  orphans: OrphanPlan[];
  /** CANCELLED children — reported explicitly, excluded from the ratio. */
  excluded: ChildPlan[];
  checkboxes: MasterCheckbox[];
  findings: MasterAuditFinding[];
  /** Non-blocking: never affect `ok`. */
  warnings: MasterAuditWarning[];
  /** Counts exclude CANCELLED children. */
  verifiedCount: number;
  totalCount: number;
}

// ── Checkbox parsing ─────────────────────────────────────────────────────────

const PHASE_ROW = /^-\s+\[([ xX~])\]\s+Phase\s+(\d+)\s*[:.]?\s*(.*)$/;
/** Trailing status claim: `— **VERIFIED**`, `- VERIFIED`, `— IN_PROGRESS`. */
const TRAILING_STATUS = /[—–-]\s*\**\s*([A-Z][A-Z_ ]{2,})\s*\**\s*$/;

/**
 * Extract phase rows from a master's `## Progress Tracking` section.
 *
 * Rows inside fenced code blocks are skipped — skill docs and plan files both
 * contain example progress blocks that are documentation, not state.
 *
 * Note this deliberately does NOT reuse `extractProgressTasks` from parser.ts:
 * that matches `Task N:`, whereas masters track `Phase N:`.
 */
export function parsePhaseCheckboxes(content: string): MasterCheckbox[] {
  const lines = content.split("\n");
  const fenced = markFencedLines(lines);
  const rows: MasterCheckbox[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = lines[i].trim().match(PHASE_ROW);
    if (!m) continue;

    const rest = m[3].trim();
    const declared = rest
      .match(TRAILING_STATUS)?.[1]
      ?.trim()
      .replace(/\s+/g, "_");

    rows.push({
      phase: parseInt(m[2], 10),
      checked: m[1].toLowerCase() === "x",
      label: rest.replace(TRAILING_STATUS, "").trim(),
      ...(declared ? { declaredStatus: declared } : {}),
      line: i,
    });
  }

  return rows;
}

// ── Child resolution ─────────────────────────────────────────────────────────

function phaseFromSlug(slug: string, masterSlug: string): number | undefined {
  const m = slug.slice(masterSlug.length).match(/^-phase-(\d+)$/);
  return m ? parseInt(m[1], 10) : undefined;
}

/**
 * Resolve a master's children from its sibling plan files.
 *
 * Primary pass: any plan whose `Parent:` matches the master's slug.
 * Second pass: any `<master-slug>-phase-*.md` NOT claimed by the first pass is
 * returned as an orphan, so a missing or misspelled link becomes a finding
 * rather than a silent omission. A child with `Repo:` is a seed: its status
 * comes from its `Location:` (`master-audit-foreign.ts`), with any finding.
 */
export function resolveChildPlans(masterPlanPath: string): {
  children: ChildPlan[];
  orphans: OrphanPlan[];
  findings: MasterAuditFinding[];
} {
  const dir = dirname(masterPlanPath);
  const masterSlug = slugFromFilename(masterPlanPath);

  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .filter((f) => basename(f, ".md") !== masterSlug)
    .sort();

  const children: ChildPlan[] = [];
  const claimed = new Set<string>();
  const findings: MasterAuditFinding[] = [];
  let workspace: string | undefined;

  for (const f of files) {
    const planFile = join(dir, f);
    let spec;
    try {
      spec = parsePlanFile(planFile);
    } catch {
      continue; // Unreadable sibling is not this master's problem.
    }
    if (spec.parent !== masterSlug) continue;

    const slug = slugFromFilename(planFile);
    claimed.add(slug);
    const foreign = spec.repo
      ? resolveForeignChild({
          planFile,
          spec,
          masterSlug,
          masterWorkspace: (workspace ??= findMasterWorkspace(masterPlanPath)),
        })
      : undefined;
    for (const f of foreign?.findings ?? []) findings.push({ ...f, slug });
    const rawStatus = foreign ? foreign.rawStatus : readRawStatus(planFile);
    children.push({
      slug,
      planFile,
      status: foreign?.status ?? spec.status,
      ...(rawStatus ? { rawStatus } : {}),
      ...(foreign ? { repo: foreign.repo } : {}),
      ...(foreign?.location ? { location: foreign.location } : {}),
      ...(spec.wave !== undefined ? { wave: spec.wave } : {}),
      ...(phaseFromSlug(slug, masterSlug) !== undefined
        ? { phase: phaseFromSlug(slug, masterSlug) }
        : {}),
    });
  }

  const orphans: OrphanPlan[] = [];
  for (const f of files) {
    const slug = basename(f, ".md");
    if (claimed.has(slug)) continue;
    if (!slug.startsWith(`${masterSlug}-phase-`)) continue;
    const planFile = join(dir, f);
    const rawStatus = readRawStatus(planFile);
    orphans.push({ slug, planFile, ...(rawStatus ? { rawStatus } : {}) });
  }

  return { children, orphans, findings };
}

// ── Audit ────────────────────────────────────────────────────────────────────

function matchCheckbox(
  child: ChildPlan,
  checkboxes: MasterCheckbox[],
): MasterCheckbox | undefined {
  if (child.phase !== undefined) {
    const byPhase = checkboxes.find((c) => c.phase === child.phase);
    if (byPhase) return byPhase;
  }
  return undefined;
}

/**
 * Reconcile a master plan against its children.
 *
 * ⛔ Only `VERIFIED` passes: `COMPLETE` means "implemented, awaiting
 * verification", and a fail-list of PENDING/IN_PROGRESS/DRAFT would let
 * COMPLETE and FAILED children through.
 */
export function auditMasterPlan(masterPlanPath: string): MasterAuditResult {
  if (!existsSync(masterPlanPath)) {
    throw new Error(`Master plan not found: ${masterPlanPath}`);
  }

  const spec = parsePlanFile(masterPlanPath);
  if (spec.type !== "master") {
    throw new Error(
      `Plan is not a master plan (Type: ${spec.type}): ${masterPlanPath}`,
    );
  }

  const content = readFileSync(masterPlanPath, "utf-8");
  const checkboxes = parsePhaseCheckboxes(content);
  const resolved = resolveChildPlans(masterPlanPath);
  const { children: all, orphans } = resolved;

  const excluded = all.filter((c) => c.status === "CANCELLED");
  const children = all.filter((c) => c.status !== "CANCELLED");
  const findings: MasterAuditFinding[] = [...resolved.findings];

  if (all.length === 0) {
    findings.push({
      kind: "no-children",
      slug: spec.id,
      message:
        `Master plan has no child plans. Expected at least one sibling with ` +
        `\`Parent: ${spec.id}\`. If children exist under different names, they are ` +
        `not linked and cannot be verified.`,
    });
  }

  // (a) Only VERIFIED passes.
  for (const c of children) {
    if (c.status === "VERIFIED") continue;
    findings.push({
      kind: "not-verified",
      slug: c.slug,
      childStatus: c.status,
      message:
        `Child is ${c.status}, not VERIFIED` +
        (c.rawStatus && c.rawStatus !== c.status
          ? ` (raw \`Status: ${c.rawStatus}\`)`
          : "") +
        `. Only VERIFIED counts as verified; COMPLETE means implemented and ` +
        `awaiting verification.`,
    });
  }

  // (b) Checkbox disagreement, in BOTH directions — including for CANCELLED.
  for (const c of [...children, ...excluded]) {
    const box = matchCheckbox(c, checkboxes);
    if (!box) continue;

    const boxSaysVerified = box.checked || box.declaredStatus === "VERIFIED";
    const childVerified = c.status === "VERIFIED";
    if (boxSaysVerified === childVerified) continue;

    findings.push({
      kind: "checkbox-disagrees",
      slug: c.slug,
      childStatus: c.status,
      checkboxChecked: box.checked,
      ...(box.declaredStatus ? { declaredStatus: box.declaredStatus } : {}),
      message: boxSaysVerified
        ? `Master checkbox claims VERIFIED but the child reads ${c.status}. The ` +
          `checkbox was written from a subagent report, not from the child file.`
        : `Child reads VERIFIED but the master checkbox is still unchecked — the ` +
          `master's record was never updated.`,
    });
  }

  // (c) Orphans — phase-named but unlinked.
  for (const o of orphans) {
    findings.push({
      kind: "orphan",
      slug: o.slug,
      message:
        `File is named like a child of this master but carries no ` +
        `\`Parent: ${spec.id}\` link` +
        (o.rawStatus ? ` (raw \`Status: ${o.rawStatus}\`)` : "") +
        `. It is not verifiable as a child — link it or rename it.`,
    });
  }

  // (d) A checkbox with no corresponding child file.
  const childPhases = new Set(
    all.map((c) => c.phase).filter((p): p is number => p !== undefined),
  );
  for (const box of checkboxes) {
    if (childPhases.has(box.phase)) continue;
    findings.push({
      kind: "missing-child",
      slug: `${spec.id}-phase-${box.phase}`,
      checkboxChecked: box.checked,
      ...(box.declaredStatus ? { declaredStatus: box.declaredStatus } : {}),
      message:
        `Master tracks "Phase ${box.phase}: ${box.label}" but no linked child ` +
        `plan exists for it.`,
    });
  }

  const reviewOn = process.env.SENTINAL_SPEC_REVIEWER_ENABLED !== "false";
  const warnings: MasterAuditWarning[] = reviewOn
    ? children
        .filter(
          (c) =>
            c.status === "VERIFIED" &&
            !existsSync(
              (c.location ?? c.planFile).replace(/\.md$/, ".spec-review.json"),
            ),
        )
        .map((c) => ({
          kind: "no-review-evidence" as const,
          slug: c.slug,
          message:
            `Child reads VERIFIED but has no ${c.slug}.spec-review.json beside ` +
            `${c.location ? `its Location (${c.location})` : "it"}, ` +
            `so /spec's code review probably did not run. Re-run verification for ` +
            `it, or confirm the review was intentionally skipped.`,
        }))
    : [];

  return {
    ok: findings.length === 0,
    master: {
      slug: spec.id,
      planFile: masterPlanPath,
      status: spec.status,
      title: spec.title,
    },
    children,
    orphans,
    excluded,
    checkboxes,
    findings,
    warnings,
    verifiedCount: children.filter((c) => c.status === "VERIFIED").length,
    totalCount: children.length,
  };
}
