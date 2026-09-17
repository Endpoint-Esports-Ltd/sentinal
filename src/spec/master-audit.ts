/**
 * Master-plan ↔ child-plan reconciliation.
 *
 * A master plan carries two independent records of the same fact, written by
 * different mechanisms, and until now nothing compared them:
 *
 *   - a child's `Status:`               — written by spec-verify, running on that child
 *   - the master's `- [x] … VERIFIED`   — written by spec-master-execute Step 4,
 *                                          from what a subagent *reported*
 *
 * So "master says VERIFIED, child says PENDING" — and equally "child says
 * VERIFIED, master checkbox still `[ ]`", which is the drift actually observed
 * in this repo — are both representable states that nothing looked for.
 *
 * ⛔ Children are resolved by the `Parent:` back-link, NOT by globbing
 * `<master-slug>-phase-*.md`. The back-link is authoritative (parsed at
 * parser.ts:63-64, persisted at store.ts:161-162). The glob is used only as a
 * SECOND pass, to surface phase-named files that carry no link — otherwise a
 * file like `…-phase-1-spike.md`, whose metadata line is prose rather than a
 * status, is silently skipped by the very check meant to catch it.
 *
 * ⛔ Direct-fs only. Do not route this through the sidecar and do not derive it
 * from `store`: MCP tools receive `store: null` in production whenever the
 * sidecar is running, which would make this audit pass every test and do
 * nothing in the field — the same defect class it exists to detect.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parsePlanFile, slugFromFilename } from "./parser.js";
import { markFencedLines } from "./parser-fences.js";
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
  | "no-children";

export interface MasterAuditFinding {
  kind: FindingKind;
  slug: string;
  message: string;
  childStatus?: SpecStatus;
  checkboxChecked?: boolean;
  declaredStatus?: string;
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

/** Raw `Status:` value, read before `normalizeStatus` collapses unknowns. */
function readRawStatus(planFile: string): string | undefined {
  const lines = readFileSync(planFile, "utf-8").split("\n").slice(0, 20);
  const fenced = markFencedLines(lines);
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const m = lines[i].trim().match(/^(?:\*\*)?Status:?(?:\*\*)?\s*(.+)$/i);
    if (m) return m[1].trim();
  }
  return undefined;
}

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
 * rather than a silent omission.
 */
export function resolveChildPlans(masterPlanPath: string): {
  children: ChildPlan[];
  orphans: OrphanPlan[];
} {
  const dir = dirname(masterPlanPath);
  const masterSlug = slugFromFilename(masterPlanPath);

  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .filter((f) => basename(f, ".md") !== masterSlug)
    .sort();

  const children: ChildPlan[] = [];
  const claimed = new Set<string>();

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
    children.push({
      slug,
      planFile,
      status: spec.status,
      ...(readRawStatus(planFile)
        ? { rawStatus: readRawStatus(planFile) }
        : {}),
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
    orphans.push({
      slug,
      planFile,
      ...(readRawStatus(planFile)
        ? { rawStatus: readRawStatus(planFile) }
        : {}),
    });
  }

  return { children, orphans };
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
 * ⛔ Only `VERIFIED` passes. `src/spec/types.ts` defines 11 statuses, and
 * `COMPLETE` means "implemented, awaiting verification" — it routes back INTO
 * spec-verify. A fail-list naming only PENDING/IN_PROGRESS/DRAFT would let
 * COMPLETE and FAILED children through, which is the bug, not the fix.
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
  const { children: all, orphans } = resolveChildPlans(masterPlanPath);

  const excluded = all.filter((c) => c.status === "CANCELLED");
  const children = all.filter((c) => c.status !== "CANCELLED");
  const findings: MasterAuditFinding[] = [];

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
    verifiedCount: children.filter((c) => c.status === "VERIFIED").length,
    totalCount: children.length,
  };
}
