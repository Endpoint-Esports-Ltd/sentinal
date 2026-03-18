/**
 * Specifications View
 *
 * Lists all specs with status, task progress, and expandable detail.
 */

import type { Spec } from "../../spec/types.js";
import {
  statusBadge,
  progressBar,
  formatTimestamp,
  emptyState,
  card,
} from "./partials.js";
import { escapeHtml } from "./layout.js";

export function specificationsView(specs: Spec[]): string {
  return `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-white">Specifications</h1>
      </div>
      <div id="specs-content" hx-get="/api/specs" hx-trigger="every 10s" hx-swap="none">
        ${specsListFragment(specs)}
      </div>
    </div>
  `;
}

export function specsListFragment(specs: Spec[]): string {
  if (specs.length === 0)
    return emptyState(
      "No specifications found. Register a plan with 'sentinal register-plan <path>'.",
    );

  return `<div class="space-y-3">
    ${specs.map((s) => specCard(s)).join("")}
  </div>`;
}

function specCard(spec: Spec): string {
  const tasksDone = spec.tasks.filter((t) => t.status === "complete").length;
  const taskList = spec.tasks
    .map((t) => {
      const icon =
        t.status === "complete"
          ? "&#10003;"
          : t.status === "in-progress"
            ? "&#9654;"
            : "&#9675;";
      const opacity = t.status === "complete" ? "opacity-60" : "";
      return `<li class="text-sm text-gray-300 ${opacity}">${icon} ${escapeHtml(t.title)}</li>`;
    })
    .join("");

  // Build timing display
  let timingHtml = "";
  if (spec.startedAt) {
    if (spec.completedAt) {
      const durationMs = spec.completedAt - spec.startedAt;
      const durationMin = Math.round(durationMs / 60000);
      const hours = Math.floor(durationMin / 60);
      const mins = durationMin % 60;
      const durationStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
      timingHtml = `<span class="text-xs text-emerald-500">&#9202; ${durationStr}</span>`;
    } else {
      const elapsedMs = Date.now() - spec.startedAt;
      const elapsedMin = Math.round(elapsedMs / 60000);
      timingHtml = `<span class="text-xs text-blue-400">&#9202; ${elapsedMin}m elapsed</span>`;
    }
  }

  const meta = [
    spec.type,
    spec.approved ? "Approved" : null,
    spec.metadata?.iterations ? `${spec.metadata.iterations} iterations` : null,
    spec.parent ? `Wave ${spec.wave ?? "?"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return card(
    spec.title,
    `
    <div class="flex items-center gap-2 mb-2">
      ${statusBadge(spec.status)}
      <span class="text-xs text-gray-500">${escapeHtml(meta)}</span>
      ${timingHtml}
    </div>
    ${progressBar(tasksDone, spec.tasks.length)}
    ${
      spec.tasks.length > 0
        ? `
      <details class="mt-3">
        <summary class="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Tasks (${tasksDone}/${spec.tasks.length})</summary>
        <ul class="mt-2 space-y-1 pl-2">${taskList}</ul>
      </details>
    `
        : ""
    }
    <p class="text-xs text-gray-600 mt-2">${escapeHtml(spec.planFile)}</p>
  `,
  );
}
