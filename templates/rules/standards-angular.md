{{frontmatter}}

## Angular Development Standards (17+)

### Components

- **Standalone components by default** — no `NgModule` unless wrapping a library

  ```typescript
  @Component({
    selector: 'app-user-card',
    standalone: true,
    imports: [CommonModule, RouterLink],
    templateUrl: './user-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
  })
  ```

- **OnPush change detection everywhere** — no exceptions
- **Smart/Dumb pattern:** Container components fetch data, presentational components receive via `@Input`
- **Component size:** Max 200 lines of TypeScript. Templates over 50 lines go to separate `.html` file

### Signals (Angular 17+)

- **Signals over RxJS** for component state:

  ```typescript
  // Correct — Signal
  count = signal(0);
  doubled = computed(() => this.count() * 2);

  // Avoid — RxJS BehaviorSubject for simple state
  count$ = new BehaviorSubject(0);
  ```

- **RxJS is still correct for:** HTTP requests, WebSocket streams, complex async orchestration
- **`toSignal()` and `toObservable()`** for interop between signals and RxJS

### Template Control Flow (Angular 17+)

- **Use built-in control flow** — no `*ngIf`, `*ngFor`, `*ngSwitch`:

  ```html
  @if (user()) {
  <app-user-card [user]="user()" />
  } @else {
  <app-loading-spinner />
  } @for (item of items(); track item.id) {
  <app-item-row [item]="item" />
  } @empty {
  <p>No items found.</p>
  }
  ```

### Styling

- **Tailwind CSS** as the primary styling approach
- **No component `.css`/`.scss` files** unless view encapsulation is needed for third-party component isolation
- **Utility-first:** Compose with Tailwind classes, extract `@apply` components only when repeated 3+ times
- Reference `ui-ux-pro-max` and `frontend-design` skills for design quality

### Routing

- **Lazy loading** for all feature routes:
  ```typescript
  { path: 'users', loadComponent: () => import('./users/users.component').then(m => m.UsersComponent) }
  ```
- **Route guards** as functional guards (not class-based):
  ```typescript
  export const authGuard: CanActivateFn = () =>
    inject(AuthService).isAuthenticated();
  ```

### Forms

- **Reactive forms** over template-driven — always
- **Typed forms** with `FormGroup<T>` and `FormControl<T>`
- **Validation:** Built-in validators + custom validators as functions, not directives

### Performance

- **`track` in @for** for all lists — always
- **Virtual scrolling** (`cdk-virtual-scroll-viewport`) for lists > 100 items
- **Lazy images** with `loading="lazy"` and `NgOptimizedImage`
- **Bundle splitting** via lazy routes — no monolithic module imports
