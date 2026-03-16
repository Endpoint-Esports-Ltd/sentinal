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

  const meta = [
    spec.type,
    spec.approved ? "Approved" : null,
    spec.metadata?.iterations ? `${spec.metadata.iterations} iterations` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return card(
    spec.title,
    `
    <div class="flex items-center gap-2 mb-2">
      ${statusBadge(spec.status)}
      <span class="text-xs text-gray-500">${escapeHtml(meta)}</span>
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
