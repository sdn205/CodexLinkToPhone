import fs from "node:fs";
import path from "node:path";

export function proxyRegistryDirectory(statePath) {
  return statePath;
}

export function isProxyInstanceAlive(state, now = Date.now()) {
  if (!state?.instanceId || state.mode !== "stdio-tee" || !state.initialized || !state.upstreamConnected) return false;
  if (!state.controlUrl || !state.token || !Array.isArray(state.loadedThreadIds)) return false;
  const updatedAt = Date.parse(state.updatedAt);
  if (!Number.isFinite(updatedAt) || now - updatedAt > 30000) return false;
  return [state.pid, state.upstreamPid].every((pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error.code === "EPERM"; }
  });
}

export function readProxyInstances(statePath, { healthyOnly = true } = {}) {
  const directory = proxyRegistryDirectory(statePath);
  let files;
  try { files = fs.readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const instances = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
      if (file !== `${state.instanceId}.json`) continue;
      if (!healthyOnly || isProxyInstanceAlive(state)) instances.push(state);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return instances.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || a.instanceId.localeCompare(b.instanceId));
}

export function createProxyInstanceRegistration(statePath, instanceId) {
  const directory = proxyRegistryDirectory(statePath);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${instanceId}.json`);
  const temporary = `${target}.tmp`;
  return {
    write(state) {
      fs.writeFileSync(temporary, JSON.stringify(state), "utf8");
      fs.renameSync(temporary, target);
    },
    remove() {
      fs.rmSync(target, { force: true });
      fs.rmSync(temporary, { force: true });
    }
  };
}
