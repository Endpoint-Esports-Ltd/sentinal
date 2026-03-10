/**
 * Sessions View
 *
 * Table of active and past sessions with duration, filters, and cleanup.
 */

import type { Session } from "../../memory/types.js";
import { statusBadge, formatTimestamp, formatDuration, emptyState } from "./partials.js";
import { escapeHtml } from "./layout.js";

export function sessionsView(sessions: Session[]): string {
  const active = sessions.filter((s) => s.endTime === null);
  const ended = sessions.filter((s) => s.endTime !== null);

  return `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-white">Sessions</h1>
        <button
          class="text-xs bg-gray-700 hover:bg-gray-600 text-gray-300 px-3 py-1.5 rounded"
          hx-post="/api/sessions/cleanup"
          hx-target="#sessions-content"
          hx-swap="innerHTML"
          hx-confirm="End all stale sessions (>24h inactive)?">
          Cleanup Stale
        </button>
      </div>

      <div id="sessions-content" hx-get="/fragments/sessions" hx-trigger="every 5s" hx-swap="innerHTML">
        ${sessionsFragment(active, ended)}
      </div>
    </div>
  `;
}

export function sessionsFragment(active: Session[], ended: Session[]): string {
  if (active.length === 0 && ended.length === 0) {
    return emptyState("No sessions recorded yet.");
  }

  let html = "";

  if (active.length > 0) {
    html += `
      <div class="mb-6">
        <h2 class="text-sm font-medium text-emerald-400 mb-2">Active (${active.length})</h2>
        ${sessionTable(active, true)}
      </div>
    `;
  }

  if (ended.length > 0) {
    html += `
      <div>
        <h2 class="text-sm font-medium text-gray-400 mb-2">Past Sessions</h2>
        ${sessionTable(ended, false)}
      </div>
    `;
  }

  return html;
}

function sessionTable(sessions: Session[], isActive: boolean): string {
  const rows = sessions
    .map((s) => {
      const dot = isActive
        ? '<span class="inline-block w-2 h-2 rounded-full bg-emerald-500 mr-2"></span>'
        : "";
      return `
        <tr class="border-t border-gray-700 hover:bg-gray-750">
          <td class="py-2 px-3 text-sm text-gray-300 font-mono">${dot}${escapeHtml(s.id.slice(0, 12))}</td>
          <td class="py-2 px-3 text-sm text-gray-400">${escapeHtml(s.projectPath.split("/").pop() ?? s.projectPath)}</td>
          <td class="py-2 px-3 text-sm">${statusBadge(s.assistant)}</td>
          <td class="py-2 px-3 text-sm text-gray-400">${formatTimestamp(s.startTime)}</td>
          <td class="py-2 px-3 text-sm text-gray-400">${formatDuration(s.startTime, s.endTime)}</td>
          <td class="py-2 px-3 text-sm text-gray-500">${s.observationCount}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-gray-500 uppercase">
          <th class="py-1 px-3">Session ID</th>
          <th class="py-1 px-3">Project</th>
          <th class="py-1 px-3">Assistant</th>
          <th class="py-1 px-3">Started</th>
          <th class="py-1 px-3">Duration</th>
          <th class="py-1 px-3">Obs</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}
