---
paths:
  - "**/controllers/**"
  - "**/services/**"
  - "**/repositories/**"
  - "**/entities/**"
  - "**/migrations/**"
  - "**/middleware/**"
  - "**/guards/**"
  - "**/interceptors/**"
  - "**/filters/**"
---



## Backend Development Standards

### API Design

- **RESTful conventions:** GET (read), POST (create), PUT/PATCH (update), DELETE (remove)
- **Consistent response format:**
  ```json
  { "data": {}, "meta": { "total": 100, "page": 1 } }
  ```
- **HTTP status codes:** 200 (OK), 201 (Created), 204 (No Content), 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found), 422 (Unprocessable), 500 (Server Error)
- **Pagination** on all list endpoints — cursor-based preferred, offset acceptable
- **Versioning** via URL prefix (`/api/v1/`) or header when needed

### Security

- **Parameterized queries** — NEVER concatenate user input into SQL/ORM queries
- **Input validation** at the API boundary — validate and sanitize all inputs via DTOs
- **Rate limiting** on authentication endpoints and expensive operations
- **CORS** configured explicitly — no wildcard `*` in production
- **Helmet** middleware for HTTP security headers
- **No secrets in code** — use environment variables via `@nestjs/config`
- **Auth tokens** — short-lived JWTs with refresh tokens, httpOnly cookies

### Database

- **Migrations only** — never modify schema manually or with `synchronize: true`
- **Reversible migrations** — every `up()` must have a working `down()`
- **Indexes** on columns used in WHERE, JOIN, ORDER BY
- **N+1 prevention:** Use `leftJoinAndSelect` / `include` for related data, or batch queries
- **Connection pooling** — configure pool size for production load
- **Transactions** for operations that modify multiple tables

### Error Handling

- **Global exception filter** for consistent error responses
- **Typed exceptions** extending `HttpException` — never throw raw `Error`
- **Log errors** with context (request ID, user ID, operation) — never log sensitive data
- **Graceful degradation** — return appropriate fallbacks, not stack traces

### Testing

- **Unit tests** for services with mocked dependencies
- **Integration tests** for controllers with test database
- **E2E tests** for complete API flows (happy path + error cases)
- **Test data factories** for creating consistent test entities
