// Create a stub for lmdb when native bindings are not available (e.g., in StackBlitz WebContainers)
const fs = require('fs');
const path = require('path');

const stubContent = `// Stub for lmdb module when native bindings are not available (e.g., in StackBlitz WebContainers)
// This provides a minimal implementation that allows the build to proceed

module.exports = {
  open: function() {
    return {
      get: function() { return undefined; },
      put: function() { return true; },
      remove: function() { return true; },
      close: function() { return true; },
      transaction: function() { return { commit: function() {} }; }
    };
  }
};
`;

const nodeModulesPath = path.join(__dirname, '..', 'node_modules');
const lmdbPath = path.join(nodeModulesPath, 'lmdb');
const stubPath = path.join(lmdbPath, 'index.js');

// Always create the stub if lmdb directory doesn't exist or if index.js is missing/broken
try {
  // Check if node_modules exists
  if (!fs.existsSync(nodeModulesPath)) {
    console.log('node_modules not found, skipping lmdb stub creation');
    process.exit(0);
  }

  // Check if we need to create the stub
  let needsStub = false;
  
  if (!fs.existsSync(lmdbPath)) {
    // lmdb wasn't installed (likely due to native addon failure in StackBlitz)
    needsStub = true;
  } else if (!fs.existsSync(stubPath)) {
    // Directory exists but no index.js
    needsStub = true;
  } else {
    // Check if the existing file is empty or very small (might be a failed native binding)
    try {
      const stats = fs.statSync(stubPath);
      if (stats.size < 100) {
        needsStub = true;
      }
    } catch (e) {
      needsStub = true;
    }
  }

  if (needsStub) {
    // Create directory if it doesn't exist
    if (!fs.existsSync(lmdbPath)) {
      fs.mkdirSync(lmdbPath, { recursive: true });
    }
    // Write stub
    fs.writeFileSync(stubPath, stubContent);
    console.log('Created lmdb stub for StackBlitz/WebContainer compatibility');
  } else {
    console.log('lmdb module found and appears to be working');
  }
} catch (error) {
  // Non-fatal error - just log and continue
  console.log('Note: Could not create lmdb stub:', error.message);
}

