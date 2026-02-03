# CodeSandbox Microservice (Render.com)

This microservice runs on [Render.com](https://render.com) and creates dynamic redirects to [CodeSandbox](https://codesandbox.io) with specific versions of the Handsontable library based on query parameters. It fetches example code from the GitHub repository and either reuses an existing tagged sandbox or creates a new one via the CodeSandbox SDK.

## Purpose

The main purpose is to create dynamic redirects to CodeSandbox from the examples folder using particular versions of the Handsontable library based on query parameters. This allows users to quickly spin up interactive examples with specific Handsontable versions for testing and demonstration purposes.

## How it Works

1. **Parameter Processing**: The service extracts query parameters to determine which example to load and which Handsontable version to use.
2. **Sandbox Lookup**: It looks up existing CodeSandbox sandboxes by tags (example-dir, handsontable version, etc.).
3. **Redirect if Found**: If a matching sandbox exists, it redirects to that sandbox.
4. **Version Resolution**: If no sandbox exists, it resolves the Handsontable version using the GitHub API and NPM registry.
5. **Second Lookup**: It looks up again with the resolved version tag; redirects if found.
6. **File Fetching**: It fetches example files from the GitHub repository.
7. **Sandbox Creation**: It creates a new sandbox via the CodeSandbox SDK, uploads files, and redirects to the new sandbox.

## Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `example-dir` | string | ✅ Yes | Directory name of the example to load (e.g., "angular", "react") |
| `example-branch` | string | ❌ No | Git branch to fetch example from (defaults to main/master) |
| `handsontable-branch` | string | ❌ No | Handsontable repository branch to use for version resolution |
| `handsontable-sha` | string | ❌ No | Specific commit SHA to use for version resolution |
| `handsontable-version` | string | ❌ No | Specific NPM version (e.g., "16.0.0") |

## Version Resolution Priority

The service resolves the Handsontable version in the following order:

1. **`handsontable-version`** – Direct NPM version (highest priority)
2. **`handsontable-branch`** – Finds NPM version matching the branch's commit SHA
3. **`handsontable-sha`** – Finds NPM version matching the specific commit SHA
4. **`latest`** – Default fallback (lowest priority)

## Example Usage

### Basic Example
```
https://your-service.onrender.com/codesandbox-vm?example-dir=angular
```

### With Specific Handsontable Version
```
https://your-service.onrender.com/codesandbox-vm?example-dir=angular&handsontable-version=16.0.0
```

### With Specific Branch
```
https://your-service.onrender.com/codesandbox-vm?example-dir=react&handsontable-branch=develop
```

### With Custom Example Branch
```
https://your-service.onrender.com/codesandbox-vm?example-dir=vue&example-branch=feature-branch&handsontable-version=15.0.0
```

## API Endpoints

- **GET** `/codesandbox-vm` – Main endpoint for CodeSandbox redirects
- **OPTIONS** – CORS preflight (if configured)

## Response Format

### Success Response
- **Status**: `302` (redirect)
- **Location**: CodeSandbox sandbox URL (e.g. `https://codesandbox.io/p/sandbox/{id}?file=&preview=true`)

### Error Response
- **Content-Type**: `application/json`
- **Body**: `{"error": "error message"}`
- **Status**: `500`

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | GitHub API token for repository access | ✅ Yes |
| `CSB_API_KEY` | CodeSandbox API key for SDK (create sandboxes, list by tags) | ✅ Yes |
| `PORT` | Port for the server (Render sets this automatically) | ❌ No (default: 3000) |
| `SLACK_WEBHOOK` | Optional Slack webhook URL for error notifications | ❌ No |

## CORS Support

Configure CORS in your Express app or at the Render.com level if you need cross-origin requests from a frontend.

## File Structure

```
render-ms/
├── index.js          # Express server and /codesandbox-vm handler
├── github.js         # GitHub API integration (fetch example files)
├── version.js        # Handsontable version resolution logic
├── package.json
├── package-lock.json
├── Dockerfile        # Node 22 Alpine image for Render.com
├── .dockerignore
├── render.yaml       # Render Blueprint (optional infra-as-code)
└── readme.md         # This documentation
```

## Dependencies

- **express** – HTTP server
- **@codesandbox/sdk** – CodeSandbox API client (list sandboxes by tags, create sandbox, upload files)
- **octokit** – GitHub API client

## Error Handling

The service handles various error scenarios:

- Missing required parameters
- GitHub API failures
- CodeSandbox API failures
- Invalid repository paths
- Network timeouts
- Invalid version specifications

All errors are returned as JSON with HTTP status 500. If `SLACK_WEBHOOK` is set, errors are also posted to Slack.

## Security Considerations

- GitHub token is required for repository access.
- CodeSandbox API key is required for creating and listing sandboxes.
- Input validation prevents path traversal attacks.
- Keep `GITHUB_TOKEN` and `CSB_API_KEY` secret in Render.com environment variables.

## Deployment on Render.com

### Option A: Docker (recommended)

The repo includes a **Dockerfile** (Node 22 Alpine) and **render.yaml** Blueprint.

1. Create a new **Web Service** on [Render.com](https://render.com).
2. Connect your repository.
3. Set **Root Directory** to `render-ms` (if the service lives in a subfolder).
4. Set **Environment** to **Docker**.
5. Render will use `Dockerfile` in the root of the service (no build/start commands needed).
6. Add environment variables: `GITHUB_TOKEN`, `CSB_API_KEY`, and optionally `SLACK_WEBHOOK`.
7. Deploy.

Or use **Blueprint**: connect the repo, add a Blueprint, and point it at `render-ms/render.yaml`. Set the env vars in the Dashboard.

### Option B: Native Node

1. Create a new **Web Service** on [Render.com](https://render.com).
2. Connect your repository and set **Root Directory** to `render-ms`.
3. **Build Command**: `npm install` (or leave default).
4. **Start Command**: `npm start`.
5. Add environment variables: `GITHUB_TOKEN`, `CSB_API_KEY`, and optionally `SLACK_WEBHOOK`.
6. Deploy.

## Comparison with Edge (Netlify + Stackblitz)

| Aspect | Edge (Netlify) | Render-ms (Render.com) |
|--------|----------------|-------------------------|
| Provider | Netlify | Render.com |
| Runtime | Deno (edge function) | Node.js (Express) |
| Playground | Stackblitz | CodeSandbox |
| Redirect | HTML form POST to Stackblitz | CodeSandbox SDK (list/create, then redirect) |
| Caching | New project per request | Reuses sandboxes by tags when possible |
