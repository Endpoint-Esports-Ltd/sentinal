/**
 * Dashboard Layout
 *
 * HTML shell that wraps all views. Includes htmx, Tailwind CSS,
 * navigation, and footer.
 */

export type PageId =
  | "dashboard"
  | "specifications"
  | "memories"
  | "sessions"
  | "settings";

const NAV_ITEMS: Array<{ id: PageId; label: string; href: string }> = [
  { id: "dashboard", label: "Dashboard", href: "/" },
  { id: "specifications", label: "Specifications", href: "/specifications" },
  { id: "memories", label: "Memories", href: "/memories" },
  { id: "sessions", label: "Sessions", href: "/sessions" },
  { id: "settings", label: "Settings", href: "/settings" },
];

/**
 * Inline htmx for air-gapped environments. This is a minimal stub
 * that loads htmx from CDN with a fallback error message.
 */
function htmxScript(): string {
  return `
    <script src="https://unpkg.com/htmx.org@2.0.4"></script>
    <script>
      if (typeof htmx === 'undefined') {
        document.addEventListener('DOMContentLoaded', function() {
          var el = document.getElementById('htmx-warning');
          if (el) el.style.display = 'block';
        });
      }
    </script>
  `;
}

export function layout(
  title: string,
  content: string,
  activePage: PageId,
  unreadCount: number = 0,
  version: string = "0.0.0",
): string {
  const navHtml = NAV_ITEMS.map((item) => {
    const isActive = item.id === activePage;
    const classes = isActive
      ? "bg-gray-900 text-white px-3 py-2 rounded-md text-sm font-medium"
      : "text-gray-300 hover:bg-gray-700 hover:text-white px-3 py-2 rounded-md text-sm font-medium";
    return `<a href="${item.href}" class="${classes}">${item.label}</a>`;
  }).join("\n          ");

  const badge = unreadCount > 0
    ? `<span class="ml-2 inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-600 text-white">${unreadCount}</span>`
    : "";

  return `<!DOCTYPE html>
<html lang="en" class="h-full bg-gray-950">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — Sentinal</title>
  <script src="https://cdn.tailwindcss.com"></script>
  ${htmxScript()}
  <style>
    [htmx-indicator] { opacity: 0; transition: opacity 200ms ease-in; }
    .htmx-request [htmx-indicator] { opacity: 1; }
  </style>
</head>
<body class="h-full">
  <div id="htmx-warning" class="hidden bg-yellow-800 text-yellow-100 text-center py-2 text-sm">
    htmx failed to load from CDN. Live updates are disabled.
  </div>

  <nav class="bg-gray-800 shadow">
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <div class="flex h-14 items-center justify-between">
        <div class="flex items-center space-x-4">
          <span class="text-white font-bold text-lg tracking-tight">Sentinal</span>
          ${badge}
        </div>
        <div class="flex items-center space-x-1">
          ${navHtml}
        </div>
      </div>
    </div>
  </nav>

  <main class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-6">
    ${content}
  </main>

  <footer class="border-t border-gray-800 mt-12">
    <div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 text-center text-gray-500 text-xs">
      Sentinal v${escapeHtml(version)} &middot; <a href="https://github.com/anomalyco/sentinal" class="hover:text-gray-300">GitHub</a>
    </div>
  </footer>
</body>
</html>`;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
