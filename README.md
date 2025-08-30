# Google Services MCP Servers

Unified Google services implementation using shared googleapis dependency.

## Structure

```
google/
├── package.json         # Shared dependencies (googleapis, MCP SDK)
├── node_modules/        # Installed once, used by all services (150MB)
├── shared/
│   └── auth.js         # Shared OAuth authentication helper
├── calendar/
│   ├── index.js        # Calendar MCP server
│   └── server-config.json
├── gmail/              # Future: Gmail using googleapis
│   └── index.js
└── drive/              # Future: Drive MCP server
    └── index.js
```

## Benefits

- **Single googleapis installation**: 150MB shared vs 150MB per service
- **Shared authentication logic**: OAuth handling in one place
- **Easy to add services**: Just add a new folder with index.js
- **Consistent API usage**: All services use the same googleapis version

## Usage

Each service is still an independent MCP server:

```bash
# Calendar
cd google && node calendar/index.js

# Gmail (when implemented)
cd google && node gmail/index.js

# Drive (when implemented)
cd google && node drive/index.js
```

## Configuration

In your MCP configuration, point to the service with working directory:

```json
{
  "name": "google-calendar",
  "command": "node",
  "args": ["calendar/index.js"],
  "workingDirectory": "./packaged-apps/google"
}
```

## Adding New Services

1. Create a new folder (e.g., `sheets/`)
2. Create `index.js` using the shared auth:
   ```javascript
   import { createAuthClient, createServiceClient } from '../shared/auth.js';
   const sheets = createServiceClient('sheets', 'v4', auth);
   ```
3. Implement MCP tools for the service
4. No need to install additional dependencies!

## Available Services

- ✅ **Calendar**: Event management, scheduling
- 🚧 **Gmail**: Email operations (coming soon)
- 🚧 **Drive**: File storage and sharing (planned)
- 🚧 **Sheets**: Spreadsheet operations (planned)
- 🚧 **Docs**: Document operations (planned)

## Migration Notes

- Old `google-calendar` directory kept as backup
- New structure reduces storage from 569MB (Gmail + Calendar) to 150MB total
- All future Google services will share the same googleapis installation