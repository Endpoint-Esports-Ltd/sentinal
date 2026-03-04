

## Frontend Development Standards

### Tailwind CSS

- **Utility-first** — compose with Tailwind classes directly in templates
- **No custom CSS** unless Tailwind cannot express the design (rare)
- **Extract components** with `@apply` only when a pattern repeats 3+ times
- **Use Tailwind config** for project design tokens (colors, spacing, fonts)
- **Dark mode** via `dark:` variant when required
- **Responsive** via `sm:`, `md:`, `lg:`, `xl:` breakpoints — mobile-first always

### Design Quality

- Reference the `ui-ux-pro-max` skill for design systems, color palettes, typography, and component patterns
- Reference the `frontend-design` skill for building distinctive, production-grade interfaces
- **No generic AI aesthetics** — every interface should have intentional design direction
- **Consistent spacing** — use Tailwind's spacing scale (4px base)
- **Typography hierarchy** — distinct heading sizes, readable body text (16px minimum)

### Accessibility (WCAG 2.1 AA)

- **Semantic HTML** — use `<nav>`, `<main>`, `<article>`, `<section>`, `<aside>`, not `<div>` soup
- **ARIA labels** on interactive elements without visible text
- **Keyboard navigation** — all interactive elements reachable via Tab, activated via Enter/Space
- **Color contrast** — minimum 4.5:1 for text, 3:1 for large text
- **Focus indicators** — visible focus rings on all interactive elements
- **Alt text** on all images — decorative images use `alt=""`

### Performance

- **Lazy images** with `loading="lazy"` attribute
- **Virtual scrolling** for lists > 100 items
- **Bundle splitting** via lazy routes — load only what's needed
- **Preload critical assets** — fonts, above-the-fold images
- **Optimize images** — use WebP/AVIF, appropriate sizes via `srcset`

### Responsive Design

- **Mobile-first** — default styles for mobile, add complexity with breakpoints
- **Fluid typography** — `clamp()` for responsive text sizes
- **No horizontal scroll** at any viewport width
- **Touch targets** — minimum 44x44px for interactive elements on mobile
