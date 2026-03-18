# Zod import compatibility (CommonJS + Node 18)

This Express backend is CommonJS (`node src/server.js`). Some Zod installs may resolve to an ESM entrypoint, which can crash CommonJS at runtime with:

- `SyntaxError: Cannot use import statement outside a module`
- `ERR_REQUIRE_ESM`

To avoid this, we do **not** import Zod directly from app modules. Instead, use:

- `const { getZod } = require('../utils/zod')`
- `const { z } = await getZod()`

Schemas are exposed via async getters (e.g. `getDocumentSchemas()`), so schema initialization happens lazily and safely.

If you need a new schema module, follow the same pattern:
- keep the file CommonJS
- lazy-init Zod-based schemas inside an async function
- export an async getter
