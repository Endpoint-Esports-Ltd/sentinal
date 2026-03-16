/**
 * Memories View
 *
 * Browse observations with search, type filters, and pagination.
 */

import type { Observation, ObservationType } from "../../memory/types.js";
import { OBSERVATION_TYPES } from "../../memory/types.js";
import { typeBadge, formatTimestamp, emptyState } from "./partials.js";
import { escapeHtml } from "./layout.js";

export function memoriesView(
  observations: Observation[],
  query: string = "",
  activeType: ObservationType | null = null,
  page: number = 1,
): string {
  return `
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h1 class="text-xl font-bold text-white">Memories</h1>
      </div>

      <div class="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          name="q"
          value="${escapeHtml(query)}"
          placeholder="Search observations..."
          class="flex-1 bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
          hx-get="/fragments/memories"
          hx-trigger="keyup changed delay:300ms"
          hx-target="#memories-list"
          hx-include="[name=type]"
        />
        <div class="flex gap-1 flex-wrap">
          <a href="/memories"
             class="px-2 py-1 rounded text-xs ${!activeType ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-300 hover:bg-gray-600"}"
             hx-get="/fragments/memories"
             hx-target="#memories-list">All</a>
          ${OBSERVATION_TYPES.map(
            (t) => `
            <a href="/memories?type=${t}"
               class="px-2 py-1 rounded text-xs ${activeType === t ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-300 hover:bg-gray-600"}"
               hx-get="/fragments/memories?type=${t}"
               hx-target="#memories-list">${t}</a>
          `,
          ).join("")}
          <input type="hidden" name="type" value="${activeType ?? ""}" />
        </div>
      </div>

      <div id="memories-list">
        ${memoriesListFragment(observations, page)}
      </div>
    </div>
  `;
}

export function memoriesListFragment(
  observations: Observation[],
  page: number = 1,
): string {
  if (observations.length === 0) return emptyState("No observations found.");

  const cards = observations
    .map((obs) => {
      const snippet =
        obs.content.length > 200
          ? obs.content.slice(0, 200) + "..."
          : obs.content;

      return `
        <div class="bg-gray-800 rounded-lg border border-gray-700 p-4">
          <div class="flex items-start justify-between mb-2">
            <div class="flex items-center gap-2">
              ${typeBadge(obs.type)}
              <h3 class="text-sm font-medium text-gray-200">${escapeHtml(obs.title)}</h3>
            </div>
            <span class="text-xs text-gray-600 whitespace-nowrap ml-2">${formatTimestamp(obs.timestamp)}</span>
          </div>
          <p class="text-xs text-gray-400 mt-1">${escapeHtml(snippet)}</p>
          ${
            obs.tags.length > 0
              ? `
            <div class="flex gap-1 mt-2">
              ${obs.tags.map((t) => `<span class="text-xs bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">${escapeHtml(t)}</span>`).join("")}
            </div>
          `
              : ""
          }
          ${
            obs.filePaths.length > 0
              ? `
            <p class="text-xs text-gray-600 mt-1">${obs.filePaths.map((f) => escapeHtml(f)).join(", ")}</p>
          `
              : ""
          }
        </div>
      `;
    })
    .join("");

  const pagination =
    observations.length >= 20
      ? `<div class="flex justify-center mt-4">
           <button
             class="text-sm text-gray-400 hover:text-white px-4 py-2 bg-gray-800 rounded border border-gray-700"
             hx-get="/fragments/memories?page=${page + 1}"
             hx-target="#memories-list"
             hx-swap="innerHTML">Load more</button>
         </div>`
      : "";

  return `<div class="space-y-3">${cards}</div>${pagination}`;
}
