# Workalong backend — UML / architecture diagrams

Diagrams use [Mermaid](https://mermaid.js.org/). They render on GitHub/GitLab and in many IDEs (Markdown preview).

| File | Contents |
|------|-----------|
| [component-diagram.md](./component-diagram.md) | HTTP stack, routes, services, `lib/`, external systems |
| [package-routes.md](./package-routes.md) | Express route registration and mount paths |
| [database-schema.md](./database-schema.md) | **PostgreSQL schema 1:1** with `database-schema/*.sql` + migrations |
| [domain-er.md](./domain-er.md) | Pointer to `database-schema.md` |

**Preview locally:** paste into [mermaid.live](https://mermaid.live) or use a Markdown preview with Mermaid support.

**CLI (optional):** `npx @mermaid-js/mermaid-cli -i component-diagram.md -o component-diagram.svg` (requires extracting the fenced block or using `.mmd`).
