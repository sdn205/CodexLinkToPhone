const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
let target;
function activate(context) {
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();
  const publish = () => {
    const root = process.env.CODEX_PHONE_REPO_ROOT || vscode.workspace.getConfiguration('codexPhone').get('bridgeRoot');
    if (!root || !path.isAbsolute(root)) return;
    const directory = path.join(root, 'proxy', 'runtime', 'workspaces');
    const nextTarget = path.join(directory, process.pid + '.json');
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file')
      .map(f => ({name: f.name, path: f.uri.fsPath}));
    const active = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
    const cwd = active?.uri.scheme === 'file' ? active.uri.fsPath : folders[0]?.path || '';
    try {
      fs.mkdirSync(directory, {recursive: true});
      fs.writeFileSync(nextTarget + '.tmp', JSON.stringify({pid: process.pid, startedAt, updatedAt: new Date().toISOString(),
        editorId: /trae/i.test(vscode.env.appName) ? 'trae' : 'vscode', editorName: vscode.env.appName, folders, cwd}) + '\n', 'utf8');
      fs.renameSync(nextTarget + '.tmp', nextTarget);
      if (target && target !== nextTarget) fs.rmSync(target, {force: true});
      target = nextTarget;
    } catch (error) { console.error('Codex Phone 工作区登记失败', error.message); }
  };
  publish();
  const timer = setInterval(publish, 5000);
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(publish),
    vscode.window.onDidChangeActiveTextEditor(publish),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('codexPhone.bridgeRoot')) publish(); }),
    {dispose() { clearInterval(timer); deactivate(); }});
}
function deactivate() {
  if (!target) return;
  try { fs.rmSync(target, {force: true}); } catch { }
  target = undefined;
}
module.exports = {activate, deactivate};
