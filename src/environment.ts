import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { PythonExtension } from '@vscode/python-extension';
import { createJob, type SceneJob } from './jobs';
import type { RenderSettings } from './export-settings';

export interface PythonEnvironment {
  python: string; env: NodeJS.ProcessEnv; selection: string;
}
export function workingDirectoryFor(uri: vscode.Uri): string {
  const fileUri = uri.scheme === 'vscode-notebook-cell' ? vscode.Uri.file(uri.fsPath) : uri;
  const root = vscode.workspace.getWorkspaceFolder(fileUri)?.uri.fsPath ?? path.dirname(fileUri.fsPath);
  return path.resolve(root, vscode.workspace.getConfiguration('manimCue', fileUri).get('workingDirectory', '') || '.');
}

/** No Python executable for the scene: "Check Python" helps. */
export class PythonNotFound extends Error {}

function probeSystemPython(cmd: string): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      const child = spawn(cmd, ['-c', 'import sys; print(sys.executable)'], { windowsHide: true });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.on('error', () => resolve(undefined));
      child.on('close', code => {
        if (code === 0 && out.trim()) resolve(out.trim().split(/\r?\n/).at(-1)?.trim());
        else resolve(undefined);
      });
      setTimeout(() => { child.kill(); resolve(undefined); }, 3000);
    } catch { resolve(undefined); }
  });
}

export async function environmentFor(uri: vscode.Uri): Promise<PythonEnvironment> {
  const fileUri = uri.scheme === 'vscode-notebook-cell' ? vscode.Uri.file(uri.fsPath) : uri;
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace to run Python.');
  const override = vscode.workspace.getConfiguration('manimCue', fileUri).get<string>('pythonPath', '').trim();
  if (override && !path.isAbsolute(override)) throw new PythonNotFound('Set “Manim Cue: Python Path” to an absolute path.');

  const api = await PythonExtension.api();
  await api.ready;

  let python: string | undefined = override || undefined;
  let selection = override ? 'manimCue.pythonPath override' : '';

  if (!python) {
    // 1. Try file-specific active environment
    let selected = api.environments.getActiveEnvironmentPath(fileUri);
    let resolved = selected ? await api.environments.resolveEnvironment(selected).catch(() => undefined) : undefined;
    if (resolved?.executable.uri?.fsPath) {
      python = resolved.executable.uri.fsPath;
      selection = `Python extension selection for this file: ${selected!.path}`;
    }

    // 2. Try workspace folder active environment
    if (!python) {
      const folder = vscode.workspace.getWorkspaceFolder(fileUri);
      if (folder) {
        selected = api.environments.getActiveEnvironmentPath(folder.uri);
        resolved = selected ? await api.environments.resolveEnvironment(selected).catch(() => undefined) : undefined;
        if (resolved?.executable.uri?.fsPath) {
          python = resolved.executable.uri.fsPath;
          selection = `Python extension selection for workspace: ${selected!.path}`;
        }
      }
    }

    // 3. Try global/workspace active environment (no resource argument)
    if (!python) {
      selected = api.environments.getActiveEnvironmentPath();
      resolved = selected ? await api.environments.resolveEnvironment(selected).catch(() => undefined) : undefined;
      if (resolved?.executable.uri?.fsPath) {
        python = resolved.executable.uri.fsPath;
        selection = `Python extension active environment: ${selected!.path}`;
      }
    }

    // 4. If selected has an absolute path on disk
    if (!python && selected?.path) {
      const p = selected.path;
      if (path.isAbsolute(p)) {
        const candidates = [p, path.join(p, 'Scripts', 'python.exe'), path.join(p, 'bin', 'python')];
        for (const cand of candidates) {
          if (await fs.stat(cand).then(() => true).catch(() => false)) {
            python = cand;
            selection = `Environment path: ${cand}`;
            break;
          }
        }
      }
    }

    // 5. Look in known environments discovered by Python extension
    if (!python && api.environments.known.length > 0) {
      for (const env of api.environments.known) {
        const cand = env.executable.uri?.fsPath;
        if (cand && path.isAbsolute(cand)) {
          python = cand;
          selection = `Discovered Python environment: ${cand}`;
          break;
        }
      }
    }

    // 6. Check 'python.defaultInterpreterPath' setting
    if (!python) {
      const defaultPath = vscode.workspace.getConfiguration('python', fileUri).get<string>('defaultInterpreterPath', '').trim();
      if (defaultPath && defaultPath !== 'python') {
        const folder = vscode.workspace.getWorkspaceFolder(fileUri);
        const resolvedPath = path.isAbsolute(defaultPath) ? defaultPath : path.resolve(folder?.uri.fsPath ?? '.', defaultPath);
        if (await fs.stat(resolvedPath).then(() => true).catch(() => false)) {
          python = resolvedPath;
          selection = `python.defaultInterpreterPath setting: ${resolvedPath}`;
        }
      }
    }

    // 7. Probe system PATH for python / python3 / py
    if (!python) {
      for (const cmd of ['python', 'python3', 'py']) {
        const cand = await probeSystemPython(cmd);
        if (cand && path.isAbsolute(cand)) {
          python = cand;
          selection = `System PATH (${cmd}): ${cand}`;
          break;
        }
      }
    }
  }

  if (!python) throw new PythonNotFound('Select a Python interpreter with “Python: Select Interpreter” or “Manim Cue: Select Python”.');

  const env: NodeJS.ProcessEnv = { ...process.env, ...api.environments.getEnvironmentVariables(fileUri) };
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[key] = `${path.dirname(python)}${path.delimiter}${env[key] ?? ''}`;
  return { python, env, selection };
}

/**
 * A job for the saved scene file with the Python and the settings of its workspace. An
 * export sets its own size and frame rate.
 */
export async function sceneJob(uri: vscode.Uri, scene: string, o: { scratch: string; helpers: string; signal: AbortSignal;
  log: (text: string) => void; sourceHash?: string; exportSettings?: RenderSettings }): Promise<{ job: SceneJob; environment: PythonEnvironment; cwd: string }> {
  const environment = await environmentFor(uri);
  const cfg = vscode.workspace.getConfiguration('manimCue', uri), cwd = workingDirectoryFor(uri);
  const fps = o.exportSettings?.fps ?? cfg.get<number>('frameRate', 30), width = o.exportSettings?.width ?? cfg.get<number>('previewWidth', 960);
  const timeout = cfg.get<number>('timeoutSeconds', 600);
  if (!(fps >= 1 && fps <= 120 && (o.exportSettings || width >= 64 && width <= 3840) && timeout >= 5 && timeout <= 7200)) {
    throw new Error('Check the Manim Cue settings for the frame rate, the preview width and the timeout.');
  }
  const job = await createJob({ ...environment, source: uri.fsPath, scene, cwd, fps, width, timeout: timeout * 1000,
    scratch: o.scratch, helpers: o.helpers, signal: o.signal, log: o.log, exportSettings: o.exportSettings }, o.sourceHash);
  return { job, environment, cwd };
}
