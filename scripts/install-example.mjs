import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exampleNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function getHeaders() {
  const headers = { 'content-type': 'application/json' };
  const token = process.env.TRUEFORGE_TOKEN;
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  return headers;
}

function getBaseUrl() {
  return (process.env.TRUEFORGE_URL ?? 'http://localhost:8790').replace(/\/+$/, '');
}

async function apiRequest({ path, method = 'GET', body }) {
  const response = await globalThis.fetch(`${getBaseUrl()}${path}`, {
    method,
    headers: getHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.error?.message ?? text ?? response.statusText;
    throw new Error(`${method} ${path} failed (${String(response.status)}): ${detail}`);
  }
  return payload;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function resolveModel() {
  if (process.env.TRUEFORGE_MODEL) {
    return process.env.TRUEFORGE_MODEL;
  }

  const response = await apiRequest({ path: '/api/v1/models' });
  const model = response.data?.[0]?.name;
  if (!model) {
    throw new Error(
      'No configured model found. Add one under Settings → Models or set TRUEFORGE_MODEL before installing.',
    );
  }
  return model;
}

async function installMissingResources({ path, resources }) {
  const configured = await apiRequest({ path });
  const configuredNames = new Set(configured.data.map(item => item.name));

  for (const manifest of resources) {
    if (configuredNames.has(manifest.name)) {
      continue;
    }
    await apiRequest({ path, method: 'PUT', body: { manifest } });
    console.log(`Configured ${manifest.name}`);
  }
}

async function installAgent({ definition, model }) {
  const manifest = globalThis.structuredClone(definition.manifest);
  manifest.model.name = manifest.model.name === '$DEFAULT_MODEL' ? model : manifest.model.name;

  const agents = await apiRequest({ path: '/api/v1/agents' });
  const existing = agents.data.find(agent => agent.name === definition.name);
  if (existing) {
    await apiRequest({
      path: `/api/v1/agents/${encodeURIComponent(existing.id)}`,
      method: 'PUT',
      body: { manifest },
    });
    console.log(`Updated agent ${definition.name}`);
    return;
  }

  await apiRequest({
    path: '/api/v1/agents',
    method: 'POST',
    body: { name: definition.name, manifest },
  });
  console.log(`Installed agent ${definition.name}`);
}

async function main() {
  const exampleName = process.argv[2];
  if (!exampleName || !exampleNamePattern.test(exampleName)) {
    throw new Error('Usage: pnpm example:install <example-name>');
  }

  const exampleDirectory = join(workspaceRoot, 'examples', exampleName);
  const [definition, requirements, model] = await Promise.all([
    readJson(join(exampleDirectory, 'agent.json')),
    readJson(join(exampleDirectory, 'requires.json')),
    resolveModel(),
  ]);

  await installMissingResources({
    path: '/api/v1/settings/mcp-servers',
    resources: requirements.mcp_servers ?? [],
  });
  await installMissingResources({
    path: '/api/v1/settings/skills',
    resources: requirements.skills ?? [],
  });
  await installAgent({ definition, model });

  console.log(`Open ${getBaseUrl()} and try ${definition.name} from the Agents Library.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
