const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const JSZip = require('jszip');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data', 'projects');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'tmp', 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

function safeProjectName(name) {
  return String(name || 'project')
    .trim()
    .replace(/[^a-zA-Z0-9_\- ]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();
}

function ensureStudioDir(projectDir) {
  const studioDir = path.join(projectDir, '.studio');
  const backupsDir = path.join(studioDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  return backupsDir;
}

function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getProjects() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => {
      const projectDir = path.join(DATA_DIR, dirent.name);
      const metadataPath = path.join(projectDir, '.studio', 'project.json');
      const metadata = fs.existsSync(metadataPath)
        ? JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
        : { name: dirent.name, createdAt: new Date().toISOString() };
      return {
        id: dirent.name,
        name: metadata.name || dirent.name,
        createdAt: metadata.createdAt || new Date().toISOString(),
        description: metadata.description || 'Godot project'
      };
    });
}

function getFileTree(projectDir) {
  const tree = [];
  const ignore = new Set(['.studio', '.git']);

  function walk(currentDir, relativeDir = '') {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.join(relativeDir, entry.name).split('\\').join('/');
      if (entry.isDirectory()) {
        const node = { name: entry.name, type: 'directory', path: relPath, children: [] };
        walk(fullPath, relPath);
        node.children = walkChildren(fullPath, relPath);
        tree.push(node);
      } else {
        tree.push({ name: entry.name, type: 'file', path: relPath });
      }
    }
  }

  function walkChildren(currentDir, relativeDir) {
    const result = [];
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      if (entry.name === '.studio') continue;
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.join(relativeDir, entry.name).split('\\').join('/');
      if (entry.isDirectory()) {
        const node = { name: entry.name, type: 'directory', path: relPath, children: walkChildren(fullPath, relPath) };
        result.push(node);
      } else {
        result.push({ name: entry.name, type: 'file', path: relPath });
      }
    }
    return result;
  }

  const rootEntries = fs.readdirSync(projectDir, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (ignore.has(entry.name)) continue;
    const fullPath = path.join(projectDir, entry.name);
    if (entry.isDirectory()) {
      const node = { name: entry.name, type: 'directory', path: entry.name, children: walkChildren(fullPath, entry.name) };
      tree.push(node);
    } else {
      tree.push({ name: entry.name, type: 'file', path: entry.name });
    }
  }
  return tree;
}

function flattenTree(tree, items = []) {
  for (const item of tree) {
    if (item.type === 'file') items.push(item.path);
    if (item.children) flattenTree(item.children, items);
  }
  return items;
}

function createBackup(projectDir, relativePath) {
  const filePath = path.join(projectDir, relativePath);
  const backupDir = ensureStudioDir(projectDir);
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeName = relativePath.replace(/[\\/]+/g, '_');
  const backupPath = path.join(backupDir, `${safeName}.${timestamp}.${hash}.bak`);
  fs.writeFileSync(backupPath, content, 'utf8');
  return backupPath;
}

function ensureProjectSeed(projectDir) {
  fs.mkdirSync(path.join(projectDir, 'scenes'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });

  const files = {
    'project.godot': `[application]
config/name="DemoRPG"
run/main_scene="res://scenes/Main.tscn"
config/features=PackedStringArray("4.2")

[rendering]
renderer/rendering_method="mobile"
`,
    'scenes/Main.tscn': `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/Player.gd" id="1"]

[node name="Main" type="Node2D"]

[node name="Player" type="Node2D" parent="."]
script = ExtResource("1")
`,
    'scripts/Player.gd': `extends Node2D

var speed = 180.0
var jump_force = 350.0
var velocity = Vector2.ZERO

func _ready() -> void:
    print("Player ready")

func _process(delta: float) -> void:
    if Input.is_action_pressed("ui_right"):
        position.x += speed * delta
    if Input.is_action_pressed("ui_left"):
        position.x -= speed * delta
    if Input.is_action_just_pressed("ui_up"):
        velocity.y = -jump_force

func _physics_process(delta: float) -> void:
    velocity.y += 20.0 * delta
    position += velocity * delta
`,
    'scripts/Game.gd': `extends Node

func _ready() -> void:
    print("Game started")
`,
    'README.md': `# DemoRPG\n\nThis project was generated by AI Game Studio for a Godot game prototype.\n`
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }

  const studioDir = path.join(projectDir, '.studio');
  fs.mkdirSync(studioDir, { recursive: true });
  const metadataPath = path.join(studioDir, 'project.json');
  if (!fs.existsSync(metadataPath)) {
    saveJson(metadataPath, {
      name: 'DemoRPG',
      createdAt: new Date().toISOString(),
      description: 'Godot prototype generated automatically'
    });
  }
}

function buildSuggestion(prompt) {
  const text = String(prompt || '').toLowerCase();
  const file = 'scripts/Player.gd';
  const defaultContent = fs.readFileSync(path.join(DATA_DIR, 'demo-rpg', file), 'utf8');
  let updated = defaultContent;
  let summary = 'Добавлены базовые элементы управления';

  if (text.includes('прыжок') || text.includes('jump')) {
    updated = defaultContent + `\n\nfunc _input(event):\n    if event.is_action_pressed("ui_accept"):\n        velocity.y = -jump_force\n`;
    summary = 'Добавлен прыжок и обработчик ввода';
  }

  if (text.includes('монет') || text.includes('coin') || text.includes('сбор')) {
    updated = defaultContent + `\n\nvar coins = 0\n\nfunc collect_coin() -> void:\n    coins += 1\n    print("Coins: %s" % coins)\n`;
    summary = 'Добавлена система очков и сбора предметов';
  }

  if (text.includes('атак') || text.includes('attack') || text.includes('удар')) {
    updated = defaultContent + `\n\nvar attack_cooldown = 0.4\nvar attack_timer = 0.0\n\nfunc _process(delta):\n    attack_timer = max(0.0, attack_timer - delta)\n    if Input.is_action_just_pressed("ui_select") and attack_timer <= 0.0:\n        print("Attack!")\n        attack_timer = attack_cooldown\n`;
    summary = 'Добавлена система атаки с таймером';
  }

  if (text.includes('платформер') || text.includes('platform')) {
    updated = `extends CharacterBody2D\n\nconst SPEED = 180.0\nconst JUMP_VELOCITY = -350.0\n\nfunc _physics_process(delta: float) -> void:\n    var direction = Input.get_axis("ui_left", "ui_right")\n    if direction:\n        velocity.x = direction * SPEED\n    else:\n        velocity.x = move_toward(velocity.x, 0, SPEED)\n\n    if is_on_floor() and Input.is_action_just_pressed("ui_accept"):\n        velocity.y = JUMP_VELOCITY\n\n    move_and_slide()\n`;
    summary = 'Сгенерирован шаблон платформера для Godot 4';
  }

  return {
    file,
    before: defaultContent,
    after: updated,
    summary
  };
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'AI Game Studio ready', mode: process.env.AI_MODE || 'local' });
});

app.get('/api/projects', (req, res) => {
  res.json(getProjects());
});

app.post('/api/projects', (req, res) => {
  const name = safeProjectName(req.body?.name || 'demo-rpg');
  const projectDir = path.join(DATA_DIR, name);
  if (fs.existsSync(projectDir)) {
    return res.status(409).json({ error: 'Project already exists' });
  }

  fs.mkdirSync(projectDir, { recursive: true });
  ensureProjectSeed(projectDir);

  const metadata = {
    name: name.replace(/-/g, ' '),
    createdAt: new Date().toISOString(),
    description: req.body?.description || 'Godot project generated automatically'
  };
  saveJson(path.join(projectDir, '.studio', 'project.json'), metadata);

  res.status(201).json({ id: name, ...metadata });
});

app.get('/api/projects/:id/files/tree', (req, res) => {
  const projectDir = path.join(DATA_DIR, req.params.id);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });
  const tree = getFileTree(projectDir);
  res.json({ files: flattenTree(tree) });
});

app.get('/api/projects/:id/files', (req, res) => {
  const projectId = req.params.id;
  const relativePath = req.query.path ? String(req.query.path) : 'project.godot';
  const projectDir = path.join(DATA_DIR, projectId);
  const filePath = path.join(projectDir, relativePath);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
  const content = fs.readFileSync(filePath, 'utf8');
  res.json({ path: relativePath, content });
});

app.post('/api/projects/:id/files/save', (req, res) => {
  const { path: relativePath, content } = req.body;
  const projectDir = path.join(DATA_DIR, req.params.id);
  if (!relativePath || !fs.existsSync(projectDir)) {
    return res.status(400).json({ error: 'Invalid project or file path' });
  }

  const filePath = path.join(projectDir, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  createBackup(projectDir, relativePath);
  fs.writeFileSync(filePath, String(content || ''), 'utf8');

  const historyPath = path.join(projectDir, '.studio', 'history.json');
  let history = [];
  if (fs.existsSync(historyPath)) {
    history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  }

  history.push({
    timestamp: new Date().toISOString(),
    action: 'save',
    path: relativePath
  });
  saveJson(historyPath, history);

  res.json({ ok: true, path: relativePath, timestamp: new Date().toISOString() });
});

app.post('/api/projects/:id/chat', (req, res) => {
  const projectId = req.params.id;
  const { prompt } = req.body;
  const projectDir = path.join(DATA_DIR, projectId);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  const patch = buildSuggestion(prompt || 'Создай базовую механику платформера для Godot');
  res.json({ ok: true, patch });
});

app.post('/api/projects/:id/patch/apply', (req, res) => {
  const { file, after } = req.body;
  const projectDir = path.join(DATA_DIR, req.params.id);
  if (!file) return res.status(400).json({ error: 'No file provided' });

  const filePath = path.join(projectDir, file);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  createBackup(projectDir, file);
  fs.writeFileSync(filePath, String(after || ''), 'utf8');

  res.json({ ok: true, file, appliedAt: new Date().toISOString() });
});

app.post('/api/projects/:id/export-zip', async (req, res) => {
  const projectId = req.params.id;
  const projectDir = path.join(DATA_DIR, projectId);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  const zip = new JSZip();

  function addFolder(folderPath, relativeRoot = '') {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(folderPath, entry.name);
      const relPath = path.join(relativeRoot, entry.name).split('\\').join('/');
      if (entry.isDirectory()) {
        if (entry.name === '.studio') continue;
        addFolder(fullPath, relPath);
      } else {
        zip.file(relPath, fs.readFileSync(fullPath));
      }
    }
  }

  addFolder(projectDir);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${projectId}.zip"`);
  res.send(buffer);
});

app.post('/api/projects/:id/import-zip', upload.single('zipFile'), async (req, res) => {
  const projectId = req.params.id;
  const projectDir = path.join(DATA_DIR, projectId);
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'Zip file is required' });
  }

  const zipData = fs.readFileSync(file.path);
  const zip = await JSZip.loadAsync(zipData);
  fs.mkdirSync(projectDir, { recursive: true });

  for (const [relativePath, zipEntry] of Object.entries(zip.files)) {
    if (zipEntry.dir) continue;
    const targetPath = path.join(projectDir, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const content = await zipEntry.async('nodebuffer');
    fs.writeFileSync(targetPath, content);
  }

  fs.unlinkSync(file.path);
  res.json({ ok: true, projectId });
});

app.get('/api/projects/:id/backups', (req, res) => {
  const projectDir = path.join(DATA_DIR, req.params.id);
  const backupDir = path.join(projectDir, '.studio', 'backups');
  if (!fs.existsSync(backupDir)) return res.json({ backups: [] });
  const backups = fs.readdirSync(backupDir).filter((entry) => entry.endsWith('.bak')).map((name) => ({ name }));
  res.json({ backups });
});

app.post('/api/projects/:id/restore', (req, res) => {
  const { backup } = req.body;
  const projectDir = path.join(DATA_DIR, req.params.id);
  const backupDir = path.join(projectDir, '.studio', 'backups');
  const backupPath = path.join(backupDir, backup);
  if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });

  const originalPath = path.join(projectDir, backup.replace(/\..*\.bak$/, '').replace(/_/g, '/'));
  fs.copyFileSync(backupPath, originalPath);
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Game Studio started on http://0.0.0.0:${PORT}`);
});
