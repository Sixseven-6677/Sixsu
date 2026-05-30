// Runs before npm/pnpm install.
// If npm (not pnpm) is running, delete node_modules so npm can install cleanly
// without conflicting with pnpm's symlink structure.
const ua = process.env.npm_config_user_agent || '';
if (!ua.includes('pnpm')) {
  const fs = require('fs');
  const path = require('path');
  const nm = path.join(__dirname, '..', 'node_modules');
  try {
    fs.rmSync(nm, { recursive: true, force: true });
    console.log('[preinstall] Cleared node_modules for clean npm install');
  } catch (e) {
    console.log('[preinstall] Note:', e.message);
  }
}
