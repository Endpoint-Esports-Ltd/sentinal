/**
 * Settings View
 *
 * Model routing configuration form with save/reset functionality.
 * Displays database info and version.
 */

import type { ModelRouting } from "../../config/types.js";
import type { MemoryStore } from "../../memory/store.js";
import { escapeHtml } from "./layout.js";
import { card } from "./partials.js";
import { statSync } from "node:fs";
import { getDbPath } from "../../memory/store.js";

export function settingsView(
  modelRouting: ModelRouting,
  version: string,
  store: MemoryStore,
): string {
  let dbSize = "N/A";
  let dbPath = "N/A";
  try {
    dbPath = getDbPath();
    const stats = statSync(dbPath);
    dbSize = formatBytes(stats.size);
  } catch {
    // Not available
  }

  return `
    <div class="space-y-6">
      <h1 class="text-xl font-bold text-white">Settings</h1>

      ${card(
        "Model Routing",
        `
        <p class="text-xs text-gray-500 mb-4">
          Advisory model preferences per spec phase. These are hints shown in command templates —
          actual model switching depends on the AI assistant.
        </p>
        <form hx-post="/api/settings" hx-target="#settings-feedback" hx-swap="innerHTML">
          <input type="hidden" name="_form" value="modelRouting" />
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
            ${modelField("Planning", "planning", modelRouting.planning)}
            ${modelField("Implementation", "implementation", modelRouting.implementation)}
            ${modelField("Verification", "verification", modelRouting.verification)}
          </div>
          <div class="flex items-center gap-3">
            <button type="submit"
              class="bg-blue-600 hover:bg-blue-700 text-white text-sm px-4 py-2 rounded">
              Save
            </button>
            <button type="button"
              class="bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm px-4 py-2 rounded"
              hx-post="/api/settings/reset"
              hx-target="#settings-feedback"
              hx-swap="innerHTML">
              Reset to Defaults
            </button>
          </div>
          <div id="settings-feedback" class="mt-3"></div>
        </form>
      `,
      )}

      ${card(
        "System Information",
        `
        <dl class="grid grid-cols-2 gap-y-2 text-sm">
          <dt class="text-gray-500">Version</dt>
          <dd class="text-gray-300">${escapeHtml(version)}</dd>
          <dt class="text-gray-500">Database Path</dt>
          <dd class="text-gray-300 font-mono text-xs">${escapeHtml(dbPath)}</dd>
          <dt class="text-gray-500">Database Size</dt>
          <dd class="text-gray-300">${escapeHtml(dbSize)}</dd>
        </dl>
      `,
      )}
    </div>
  `;
}

function modelField(label: string, name: string, value: string): string {
  return `
    <div>
      <label class="block text-xs text-gray-400 mb-1">${escapeHtml(label)}</label>
      <input type="text" name="${name}" value="${escapeHtml(value)}"
        class="w-full bg-gray-900 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-600" />
    </div>
  `;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
