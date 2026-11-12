import * as vscode from 'vscode';
import * as path from 'node:path';
import { PythonExtension } from '@vscode/python-extension';

/** Explicit Cue-only override. Never install packages or alter the Python extension's selection. */
export async function selectPythonFor(uri: vscode.Uri): Promise<boolean> {
  const fileUri = uri.scheme === 'vscode-notebook-cell' ? vscode.Uri.file(uri.fsPath) : uri;
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to set up Python.');
  const api = await PythonExtension.api();
  await api.ready;
  if (api.environments.known.length === 0) {
    await api.environments.refreshEnvironments().catch(() => {});
  }
  const current = vscode.workspace.getConfiguration('manimCue', fileUri).get<string>('pythonPath', '');
  const selected = api.environments.getActiveEnvironmentPath(fileUri)?.path || api.environments.getActiveEnvironmentPath()?.path || '';
  type Choice = vscode.QuickPickItem & { executable?: string; action?: 'follow' | 'enter' };
  const choices: Choice[] = [
    { label: 'Use “Python: Select Interpreter”', description: current ? undefined : 'Active', detail: `Selected for this file: ${selected}`, action: 'follow' },
    { label: 'Enter the path of a Python executable…', detail: 'For example, /path/to/.venv/bin/python', action: 'enter' },
  ];
  const paths = new Set<string>();
  for (const environment of api.environments.known) {
    const executable = environment.executable.uri?.fsPath;
    if (!executable || paths.has(executable)) continue;
    paths.add(executable);
    choices.push({ label: environment.environment?.name || path.basename(path.dirname(executable)),
      description: executable === current ? 'Active' : undefined, detail: executable, executable });
  }
  const choice = await vscode.window.showQuickPick(choices, {
    title: `Python for Manim Cue — ${path.basename(fileUri.fsPath)}`,
    placeHolder: 'Choose a Python interpreter', matchOnDetail: true,
  });
  if (!choice) return false;
  let executable = choice.action === 'follow' ? '' : choice.executable;
  if (choice.action === 'enter') executable = await vscode.window.showInputBox({
    title: 'Python executable for Manim Cue', value: current || selected,
    prompt: 'The full path of the executable, for example /path/to/.venv/bin/python',
    validateInput: value => path.isAbsolute(value.trim()) ? undefined : 'Enter the full path.',
  });
  if (executable === undefined) return false;
  const folder = vscode.workspace.getWorkspaceFolder(fileUri);
  // Loose files have no folder settings. Explain any broader scope before applying it.
  const hasWorkspace = !!(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  const scope = folder ? `workspace folder “${folder.name}”` : hasWorkspace
    ? 'this workspace (the scene is outside its opened folders)'
    : 'User settings (all workspaces without their own override)';
  const answer = await vscode.window.showInformationMessage(
    `${executable ? `Use ${executable.trim()}` : 'Use the interpreter from “Python: Select Interpreter”'} for Manim Cue in ${scope}?`,
    { modal: true }, 'Apply',
  );
  if (answer !== 'Apply') return false;
  await vscode.workspace.getConfiguration('manimCue', fileUri).update('pythonPath', executable.trim(),
    folder ? vscode.ConfigurationTarget.WorkspaceFolder : hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
  return true;
}
