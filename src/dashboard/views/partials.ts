/**
 * Shared HTML Partials
 *
 * Reusable HTML fragments used across multiple views.
 */

import { escapeHtml } from "./layout.js";

// ─── Status Badges ──────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-600",
  "in progress": "bg-blue-600",
  "in-progress": "bg-blue-600",
  in_progress: "bg-blue-600",
  approved: "bg-green-600",
  complete: "bg-green-700",
  completed: "bg-green-700",
  verified: "bg-emerald-600",
  cancelled: "bg-red-700",
  failed: "bg-red-600",
  draft: "bg-gray-600",
  rejected: "bg-red-600",
  active: "bg-emerald-600",
  ended: "bg-gray-600",
};

export function statusBadge(status: string): string {
  const normalized = status.toLowerCase();
  const color = STATUS_COLORS[normalized] ?? "bg-gray-600";
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color} text-white">${escapeHtml(status)}</span>`;
}

// ─── Type Badges ────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  decision: "bg-purple-600",
  discovery: "bg-blue-600",
  error: "bg-red-600",
  fix: "bg-green-600",
  pattern: "bg-yellow-600",
  info: "bg-blue-500",
  warning: "bg-yellow-500",
  success: "bg-green-500",
};

export function typeBadge(type: string): string {
  const color = TYPE_COLORS[type] ?? "bg-gray-600";
  return `<span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${color} text-white">${escapeHtml(type)}</span>`;
}

// ─── Progress Bar ───────────────────────────────────────────────────────────

export function progressBar(done: number, total: number): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return `
    <div class="flex items-center gap-2">
      <div class="flex-1 bg-gray-700 rounded-full h-2">
        <div class="bg-blue-500 h-2 rounded-full transition-all" style="width: ${pct}%"></div>
      </div>
      <span class="text-xs text-gray-400">${done}/${total}</span>
    </div>
  `;
}

// ─── Timestamp Formatting ───────────────────────────────────────────────────

export function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDuration(startMs: number, endMs?: number | null): string {
  const end = endMs ?? Date.now();
  const diff = end - startMs;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

// ─── Empty State ────────────────────────────────────────────────────────────

export function emptyState(message: string): string {
  return `
    <div class="text-center py-12">
      <p class="text-gray-500 text-sm">${escapeHtml(message)}</p>
    </div>
  `;
}

// ─── Card ───────────────────────────────────────────────────────────────────

export function card(title: string, content: string, extra?: string): string {
  return `
    <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
      <h3 class="text-sm font-medium text-gray-300 mb-3">${escapeHtml(title)}</h3>
      ${content}
      ${extra ?? ""}
    </div>
  `;
}
