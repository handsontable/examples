# Stackblitz Edge Function

This Netlify Edge Function creates dynamic redirects to Stackblitz with specific versions of the Handsontable library based on query parameters. It fetches example code from the GitHub repository and creates a Stackblitz project with the specified Handsontable version.

## Purpose

The main purpose is to create dynamic redirects to Stackblitz from the examples folder using particular versions of the Handsontable library based on query parameters. This allows users to quickly spin up interactive examples with specific Handsontable versions for testing and demonstration purposes.

## How it Works

1. **Parameter Processing**: The function extracts query parameters to determine which example to load and which Handsontable version to use
2. **Version Resolution**: It resolves the Handsontable version using GitHub API and NPM registry
3. **File Fetching**: It fetches example files from the GitHub repository
4. **Package Configuration**: It updates the package.json with the specified Handsontable version
5. **Stackblitz Redirect**: It creates an HTML form that automatically submits to Stackblitz with the configured project

## Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `example-dir` | string | ✅ Yes | Directory name of the example to load (e.g., "example1") |
| `example-branch` | string | ❌ No | Git branch to fetch example from (defaults to main/master) |
| `handsontable-branch` | string | ❌ No | Handsontable repository branch to use for version resolution |
| `handsontable-sha` | string | ❌ No | Specific commit SHA to use for version resolution |
| `handsontable-version` | string | ❌ No | Specific NPM version (e.g., "16.0.0") |

## Version Resolution Priority

The function resolves the Handsontable version in the following order:

1. **`handsontable-version`** - Direct NPM version (highest priority)
2. **`handsontable-branch`** - Finds NPM version matching the branch's commit SHA
3. **`handsontable-sha`** - Finds NPM version matching the specific commit SHA
4. **`latest`** - Default fallback (lowest priority)

## Example Usage

### Basic Example
```
https://your-domain.netlify.app/stackblitz?example-dir=example1
```

### With Specific Handsontable Version
```
https://your-domain.netlify.app/stackblitz?example-dir=example1&handsontable-version=16.0.0
```

### With Specific Branch
```
https://your-domain.netlify.app/stackblitz?example-dir=example1&handsontable-branch=develop
```

### With Custom Example Branch
```
https://your-domain.netlify.app/stackblitz?example-dir=example1&example-branch=feature-branch&handsontable-version=15.0.0
```

## API Endpoints

- **GET** `/stackblitz` - Main endpoint for Stackblitz redirects
- **OPTIONS** `/stackblitz` - CORS preflight handling

## Response Format

### Success Response
- **Content-Type**: `text/html`
- **Body**: HTML form that auto-submits to Stackblitz
- **Status**: `200`

### Error Response
- **Content-Type**: `application/json`
- **Body**: `{"error": "error message"}`
- **Status**: `500`

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_TOKEN` | GitHub API token for repository access | ✅ Yes |

## CORS Support

The function includes CORS headers to support cross-origin requests:
- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Allow-Headers: Content-Type`

## File Structure

```
edge/
├── netlify/
│   └── edge-functions/
│       └── stackblitz.mts          # Main edge function
├── src/
│   ├── index.ts                    # HTML utilities
│   ├── github.ts                   # GitHub API integration
│   └── version.ts                  # Version resolution logic
├── netlify.toml                    # Netlify configuration
└── readme.md                       # This documentation
```

## Dependencies

- **@octokit/rest** - GitHub API client
- **Deno** - Runtime environment for edge functions

## Error Handling

The function handles various error scenarios:
- Missing required parameters
- GitHub API failures
- Invalid repository paths
- Network timeouts
- Invalid version specifications

All errors are returned as JSON with appropriate HTTP status codes.

## Security Considerations

- GitHub token is required for private repository access
- Public repositories could be accessed without tokens (future optimization)
- Input validation prevents path traversal attacks
- CORS headers are properly configured

## Performance

- Files are fetched in parallel using Promise.all
- GitHub API calls are optimized to minimize requests
- Version resolution is cached where possible
- Edge function provides low-latency responses
