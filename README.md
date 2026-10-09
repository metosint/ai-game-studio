const state = {
  projects: [],
  activeProject: null,
  fileTree: [],
  activeFile: null,
  pendingPatch: null,
  draft: ''
};

const projectListEl = document.getElementById('projectList');
const fileTreeEl = document.getElementById('fileTree');
const editorEl = document.getElementById('editor');
const promptInputEl = document.getElementById('promptInput');
const chatOutputEl = document.getElementById('chatOutput');
const projectTitleEl = document.getElementById('projectTitle');
const diffModalEl = document.getElementById('diffModal');
const beforeCodeEl = document.getElementById('beforeCode');
const afterCodeEl = document.getElementById('afterCode');
const diffSummaryEl = document.getElementById('diffSummary');

function showMessage(text, role = 'bot') {
  const msg = document.createElement('div');
  msg.className = 'message';
  msg.innerHTML = `<strong>${role === 'bot' ? 'AI' : 'Вы'}:</strong><br>${text}`;
  chatOutputEl.appendChild(msg);
  chatOutputEl.scrollTop = chatOutputEl.scrollHeight;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

function renderProjects() {
  projectListEl.innerHTML = '';

  for (const project of state.projects) {
    const btn = document.createElement('button');
    btn.className = `project-item ${state.activeProject === project.id ? 'active' : ''}`;
    btn.textContent = project.name;
    btn.onclick = () => openProject(project.id);
    projectListEl.appendChild(btn);
  }
}

function renderFileTree(tree, parent = null) {
  fileTreeEl.innerHTML = '';

  const walk = (items) => {
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'tree-item';
      row.textContent = item.name;
      if (item.type === 'file') {
        row.onclick = () => openFile(item.path);
        if (state.activeFile === item.path) row.classList.add('active');
      }
      fileTreeEl.appendChild(row);

      if (item.children && item.children.length) {
        const childWrap = document.createElement('div');
        childWrap.style.marginLeft = '12px';
        walk(item.children);
      }
    }
  };

  if (tree && tree.length) {
    walk(tree);
  }
}

async function refreshProjects() {
  const projects = await fetchJson('/api/projects');
  state.projects = projects;
  renderProjects();
  if (!state.activeProject && projects.length) {
    openProject(projects[0].id);
  }
}

async function openProject(projectId) {
  state.activeProject = projectId;
  state.activeFile = null;
  projectTitleEl.textContent = projectId;
  renderProjects();

  const data = await fetchJson(`/api/projects/${projectId}/files/tree`);
  const tree = buildTreeFromFiles(data.files);
  state.fileTree = tree;
  renderFileTree(tree);

  const firstFile = data.files.find((item) => item.endsWith('.gd') || item.endsWith('.tscn') || item.endsWith('.md') || item.endsWith('.godot'));
  if (firstFile) openFile(firstFile);
}

function buildTreeFromFiles(files) {
  const root = [];

  for (const file of files) {
    const parts = file.split('/');
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isFile = i === parts.length - 1;
      let existing = current.find((node) => node.name === part);

      if (!existing) {
        existing = {
          name: part,
          type: isFile ? 'file' : 'directory',
          path: parts.slice(0, i + 1).join('/'),
          children: []
        };
        current.push(existing);
      }

      if (!isFile) {
        current = existing.children;
      }
    }
  }

  return root;
}

async function openFile(filePath) {
  if (!state.activeProject) return;
  state.activeFile = filePath;
  const data = await fetchJson(`/api/projects/${state.activeProject}/files?path=${encodeURIComponent(filePath)}`);
  editorEl.value = data.content;
  state.draft = data.content;
  renderFileTree(state.fileTree);
}

async function saveFile() {
  if (!state.activeProject || !state.activeFile) return;
  const payload = { path: state.activeFile, content: editorEl.value };
  await fetchJson(`/api/projects/${state.activeProject}/files/save`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  showMessage(`Файл ${state.activeFile} сохранён`, 'Вы');
}

async function createProject() {
  const name = window.prompt('Название проекта (например: platformer-demo):', 'platformer-demo');
  if (!name) return;
  try {
    const project = await fetchJson('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, description: 'Project created in browser' })
    });
    await refreshProjects();
    openProject(project.id);
  } catch (err) {
    alert(err.message);
  }
}

async function generateAiPatch() {
  const prompt = promptInputEl.value.trim();
  if (!prompt || !state.activeProject) return;

  try {
    const result = await fetchJson(`/api/projects/${state.activeProject}/chat`, {
      method: 'POST',
      body: JSON.stringify({ prompt })
    });

    const patch = result.patch;
    state.pendingPatch = patch;
    beforeCodeEl.textContent = patch.before;
    afterCodeEl.textContent = patch.after;
    diffSummaryEl.textContent = patch.summary;
    diffModalEl.classList.remove('hidden');
    showMessage(`${patch.summary}`, 'AI');
  } catch (err) {
    showMessage(`Ошибка ИИ: ${err.message}`, 'AI');
  }
}

async function applyPatch() {
  if (!state.pendingPatch || !state.activeProject) return;

  await fetchJson(`/api/projects/${state.activeProject}/patch/apply`, {
    method: 'POST',
    body: JSON.stringify({
      file: state.pendingPatch.file,
      after: state.pendingPatch.after
    })
  });

  diffModalEl.classList.add('hidden');
  state.pendingPatch = null;
  await openFile(state.pendingPatch ? state.pendingPatch.file : state.activeFile);
  showMessage('Изменения применены и сохранены', 'AI');
}

async function exportProjectZip() {
  if (!state.activeProject) return;

  const response = await fetch(`/api/projects/${state.activeProject}/export-zip`, { method: 'POST' });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.activeProject}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

async function importProjectZip(file) {
  if (!state.activeProject || !file) return;
  const formData = new FormData();
  formData.append('zipFile', file);

  await fetch(`/api/projects/${state.activeProject}/import-zip`, {
    method: 'POST',
    body: formData
  });

  await openProject(state.activeProject);
  showMessage('ZIP импортирован', 'Вы');
}

async function init() {
  try {
    await refreshProjects();
  } catch (err) {
    showMessage(`Не удалось загрузить проект: ${err.message}`, 'AI');
  }
}

document.getElementById('newProjectBtn').onclick = createProject;
document.getElementById('saveBtn').onclick = saveFile;
document.getElementById('generateBtn').onclick = generateAiPatch;
document.getElementById('applyPatchBtn').onclick = applyPatch;
document.getElementById('cancelPatchBtn').onclick = () => {
  diffModalEl.classList.add('hidden');
  state.pendingPatch = null;
};
document.getElementById('exportBtn').onclick = exportProjectZip;
document.getElementById('importInput').onchange = (event) => importProjectZip(event.target.files[0]);

editorEl.addEventListener('input', () => {
  state.draft = editorEl.value;
});

init();
