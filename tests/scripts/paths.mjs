import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const project = path.join(root, 'server');
export const testRoot = path.join(root, 'tests');
export const build = path.join(testRoot, 'build');
export const executable = process.env.BRIDGE_TEST_EXE || path.join(project, 'dist/codex-phone-bridge.exe');
