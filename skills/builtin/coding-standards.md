---
name: coding-standards
---

# Coding Standards Skill

When writing code, follow these standards:

## TypeScript
- Use strict mode, ES modules, 2-space indentation
- Prefer `const` over `let`, avoid `var`
- Use explicit return types for exported functions
- Use Zod for runtime validation of external data
- No `any` unless absolutely necessary (add `// eslint-disable-line @typescript-eslint/no-explicit-any`)

## Testing
- Write unit tests for pure functions
- Integration tests for API routes and DB operations
- Use Vitest with `describe`/`it` blocks
- Mock external services (APIs, DB) in unit tests

## Code Style
- No comments unless explaining "why" not "what"
- Use early returns to reduce nesting
- Prefer composition over inheritance
- Small, single-purpose functions (< 50 lines)

## Error Handling
- Always handle promise rejections
- Use `try/catch` for async operations
- Return `Result<T, E>` or throw typed errors
- Never silently swallow errors