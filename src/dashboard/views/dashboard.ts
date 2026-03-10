/**
 * Dashboard (Home) View
 *
 * Shows workspace overview: active sessions, spec progress,
 * recent notifications, quick stats.
 */

import type { Session, Notification, MemoryStats } from "../../memory/types.js";
import type { Spec } from "../../spec/types.js";
import {
  card,
  statusBadge,
  typeBadge,
  progressBar,
  formatTimestamp,
  formatDuration,
  emptyState,
} from "./partials.js";
import { escapeHtml } from "./layout.js";

export interface DashboardData {
  activeSessions: Session[];
  recentSpecs: Spec[];
  notifications: Notification[];
  stats: MemoryStats;
}

export function dashboardView(data: DashboardData): string {
  return `
    <div id="dashboard-content" hx-get="/fragments/dashboard" hx-trigger="every 5s" hx-swap="innerHTML">
      ${dashboardFragment(data)}
    </div>
  `;
}

export function dashboardFragment(data: DashboardData): string {
  return `
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
      ${statCard("Active Sessions", String(data.activeSessions.length), "text-emerald-400")}
      ${statCard("Total Observations", String(data.stats.totalObservations), "text-blue-400")}
      ${statCard("Total Sessions", String(data.stats.totalSessions), "text-purple-400")}
      ${statCard("DB Size", formatBytes(data.stats.databaseSizeBytes), "text-gray-400")}
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      ${card("Active Sessions", sessionsFragment(data.activeSessions))}
      ${card("Recent Specifications", specsFragment(data.recentSpecs))}
    </div>

    <div class="mt-6">
      ${card("Recent Notifications", notificationsFragment(data.notifications))}
    </div>
  `;
}

function statCard(label: string, value: string, color: string): string {
  return `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <p class="text-xs text-gray-500 uppercase tracking-wide">${escapeHtml(label)}</p>
      <p class="text-2xl font-bold ${color} mt-1">${escapeHtml(value)}</p>
    </div>
  `;
}

function sessionsFragment(sessions: Session[]): string {
  if (sessions.length === 0) return emptyState("No active sessions");

  const rows = sessions
    .map(
      (s) => `
    <tr class="border-t border-gray-700">
      <td class="py-2 px-3 text-sm text-gray-300 font-mono">${escapeHtml(s.id.slice(0, 8))}...</td>
      <td class="py-2 px-3 text-sm text-gray-400">${escapeHtml(s.projectPath.split("/").pop() ?? s.projectPath)}</td>
      <td class="py-2 px-3 text-sm">${statusBadge(s.assistant)}</td>
      <td class="py-2 px-3 text-sm text-gray-400">${formatDuration(s.startTime)}</td>
    </tr>
  `,
    )
    .join("");

  return `
    <table class="w-full">
      <thead>
        <tr class="text-left text-xs text-gray-500 uppercase">
          <th class="py-1 px-3">Session</th>
          <th class="py-1 px-3">Project</th>
          <th class="py-1 px-3">Assistant</th>
          <th class="py-1 px-3">Duration</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function specsFragment(specs: Spec[]): string {
  if (specs.length === 0) return emptyState("No specifications found");

  return specs
    .slice(0, 5)
    .map(
      (s) => `
    <div class="border-t border-gray-700 py-3 first:border-0">
      <div class="flex items-center justify-between mb-1">
        <span class="text-sm text-gray-200">${escapeHtml(s.title)}</span>
        ${statusBadge(s.status)}
      </div>
      ${progressBar(s.tasks.filter((t) => t.status === "complete").length, s.tasks.length)}
    </div>
  `,
    )
    .join("");
}

function notificationsFragment(notifications: Notification[]): string {
  if (notifications.length === 0) return emptyState("No notifications");

  return notifications
    .slice(0, 10)
    .map(
      (n) => `
    <div class="flex items-start gap-3 border-t border-gray-700 py-3 first:border-0 ${n.read ? "opacity-60" : ""}">
      <div class="mt-0.5">${typeBadge(n.type)}</div>
      <div class="flex-1 min-w-0">
        <p class="text-sm text-gray-200">${escapeHtml(n.title)}</p>
        ${n.message ? `<p class="text-xs text-gray-500 mt-0.5">${escapeHtml(n.message)}</p>` : ""}
      </div>
      <span class="text-xs text-gray-600 whitespace-nowrap">${formatTimestamp(n.createdAt)}</span>
    </div>
  `,
    )
    .join("");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
