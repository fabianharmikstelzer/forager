import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from 'fs';
import { join, basename } from 'path';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { upsertSession, getSessionMtime } from './db.js';
import { embed, embeddingToBuffer } from './embeddings.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl');
const MAX_USER_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 300;
const SESSION_GAP_MS = 30 * 60 * 1000; // 30 min gap = new session

// --- Scanning ---

function scanAllSessions() {
  const indexed = new Map(); // sessionId -> entry from index
  const allJsonlFiles = [];  // all .jsonl paths found

  let projectDirs;
  try {
    projectDirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
  } catch {
    projectDirs = [];
  }

  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectDir = join(CLAUDE_PROJECTS_DIR, dir.name);

    // Read index if it exists
    const indexPath = join(projectDir, 'sessions-index.json');
    if (existsSync(indexPath)) {
      try {
        const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
        if (data.entries) {
          for (const entry of data.entries) {
            indexed.set(entry.sessionId, entry);
          }
        }
      } catch { /* skip bad index */ }
    }

    // Scan for all JSONL files in this project dir
    try {
      const files = readdirSync(projectDir);
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          allJsonlFiles.push({
            path: join(projectDir, file),
            projectDirName: dir.name,
          });
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  // Build unified entry list
  const entries = [];
  const seenIds = new Set();

  // First, add all indexed entries
  for (const entry of indexed.values()) {
    entries.push({ ...entry, source: 'index' });
    seenIds.add(entry.sessionId);
  }

  // Then, find orphaned JSONL files not in any index
  for (const { path, projectDirName } of allJsonlFiles) {
    const fileName = basename(path, '.jsonl');
    if (!seenIds.has(fileName)) {
      entries.push({
        sessionId: fileName,
        fullPath: path,
        projectDirName,
        source: 'orphan',
      });
      seenIds.add(fileName);
    }
  }

  // Finally, scan history.jsonl for prompt-only sessions
  const historySessions = scanHistoryFile(seenIds);
  for (const hs of historySessions) {
    entries.push(hs);
  }

  return entries;
}

function scanHistoryFile(seenSessionIds) {
  if (!existsSync(HISTORY_PATH)) return [];

  let lines;
  try {
    lines = readFileSync(HISTORY_PATH, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }

  // Parse all entries
  const entries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.display && obj.timestamp) {
        entries.push(obj);
      }
    } catch { /* skip */ }
  }

  // Sort by timestamp
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Group into sessions: same project, within SESSION_GAP_MS
  const sessions = [];
  let current = null;

  for (const e of entries) {
    if (current && e.project === current.project && (e.timestamp - current.lastTs) < SESSION_GAP_MS) {
      current.prompts.push(e.display);
      current.lastTs = e.timestamp;
    } else {
      if (current) sessions.push(current);
      current = {
        project: e.project || '',
        firstTs: e.timestamp,
        lastTs: e.timestamp,
        prompts: [e.display],
      };
    }
  }
  if (current) sessions.push(current);

  // Convert to entries, using a stable synthetic ID based on timestamp+project
  const result = [];
  for (const s of sessions) {
    // Create a stable ID from the first timestamp + project so re-indexing doesn't duplicate
    const syntheticId = `history-${s.firstTs}-${simpleHash(s.project)}`;

    // Skip if we already have a full session covering this time range
    // (We can't perfectly match, but skip if the synthetic ID is already indexed)
    if (seenSessionIds.has(syntheticId)) continue;

    result.push({
      sessionId: syntheticId,
      projectPath: s.project,
      gitBranch: '',
      firstPrompt: s.prompts[0] || '',
      summary: '',
      created: new Date(s.firstTs).toISOString(),
      modified: new Date(s.lastTs).toISOString(),
      messageCount: s.prompts.length,
      prompts: s.prompts,
      source: 'history',
    });
  }

  return result;
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// --- JSONL extraction ---

async function extractMetadataFromJsonl(jsonlPath) {
  if (!existsSync(jsonlPath)) return null;

  const meta = {
    sessionId: null,
    projectPath: null,
    gitBranch: null,
    firstPrompt: null,
    created: null,
    modified: null,
    messageCount: 0,
  };

  const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        if (obj.type === 'user' && obj.message?.content) {
          meta.messageCount++;
          if (!meta.sessionId) meta.sessionId = obj.sessionId;
          if (!meta.projectPath) meta.projectPath = obj.cwd;
          if (!meta.gitBranch) meta.gitBranch = obj.gitBranch;
          if (!meta.created) meta.created = obj.timestamp;
          meta.modified = obj.timestamp;

          if (!meta.firstPrompt) {
            const content = typeof obj.message.content === 'string'
              ? obj.message.content
              : JSON.stringify(obj.message.content);
            meta.firstPrompt = content.slice(0, 500);
          }
        } else if (obj.type === 'assistant') {
          meta.messageCount++;
          if (obj.timestamp) meta.modified = obj.timestamp;
        }
      } catch { /* skip malformed lines */ }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return meta;
}

async function extractUserMessages(jsonlPath) {
  if (!existsSync(jsonlPath)) return [];

  const messages = [];
  const fileStream = createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'user' && obj.message?.content) {
          const content = typeof obj.message.content === 'string'
            ? obj.message.content
            : JSON.stringify(obj.message.content);
          const truncated = content.length > MAX_MESSAGE_LENGTH
            ? content.slice(0, MAX_MESSAGE_LENGTH) + '...'
            : content;
          messages.push(truncated);
          if (messages.length >= MAX_USER_MESSAGES) break;
        }
      } catch {
        // skip malformed lines
      }
    }
  } finally {
    rl.close();
    fileStream.destroy();
  }

  return messages;
}

// --- Helpers ---

function projectDirToPath(dirName) {
  return dirName.replace(/^-/, '/').replace(/-/g, '/');
}

function buildDocument(entry, userMessages) {
  const parts = [];

  if (entry.projectPath) {
    parts.push(`Project: ${entry.projectPath}`);
  }
  if (entry.gitBranch) {
    parts.push(`Branch: ${entry.gitBranch}`);
  }
  if (entry.summary) {
    parts.push(`Summary: ${entry.summary}`);
  }
  if (entry.firstPrompt) {
    parts.push(`First prompt: ${entry.firstPrompt}`);
  }
  if (userMessages.length > 0) {
    parts.push(`Key messages: ${userMessages.join(' | ')}`);
  }

  return parts.join('\n');
}

function buildHistoryDocument(entry) {
  const parts = [];

  if (entry.projectPath) {
    parts.push(`Project: ${entry.projectPath}`);
  }
  if (entry.firstPrompt) {
    parts.push(`First prompt: ${entry.firstPrompt}`);
  }
  if (entry.prompts && entry.prompts.length > 0) {
    const truncated = entry.prompts.map((p) =>
      p.length > MAX_MESSAGE_LENGTH ? p.slice(0, MAX_MESSAGE_LENGTH) + '...' : p
    );
    parts.push(`Prompts: ${truncated.join(' | ')}`);
  }

  return parts.join('\n');
}

// --- Main indexer ---

export async function indexSessions({ full = false, onProgress } = {}) {
  const allEntries = scanAllSessions();
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  const totalEntries = allEntries.length;
  if (onProgress) onProgress({ type: 'start', total: totalEntries });

  for (const entry of allEntries) {
    try {
      // Determine file mtime for change detection
      let fileMtime;
      if (entry.source === 'history') {
        // Use history.jsonl mtime for history-sourced entries
        try { fileMtime = statSync(HISTORY_PATH).mtimeMs; } catch { fileMtime = 0; }
      } else {
        fileMtime = entry.fileMtime || (() => {
          try { return statSync(entry.fullPath).mtimeMs; } catch { return 0; }
        })();
      }

      // Skip already indexed sessions (unless --full)
      if (!full) {
        const existingMtime = getSessionMtime(entry.sessionId);
        if (existingMtime !== null && existingMtime === fileMtime) {
          skipped++;
          if (onProgress) onProgress({ type: 'skip', sessionId: entry.sessionId, summary: entry.summary });
          continue;
        }
      }

      let document;
      let enrichedEntry = entry;

      if (entry.source === 'history') {
        // History-only sessions: build document from prompts
        document = buildHistoryDocument(entry);
      } else {
        // For orphaned sessions, extract metadata from the JSONL itself
        if (entry.source === 'orphan') {
          const meta = await extractMetadataFromJsonl(entry.fullPath);
          if (!meta || !meta.firstPrompt) {
            skipped++;
            if (onProgress) onProgress({ type: 'skip', sessionId: entry.sessionId, summary: '(empty session)' });
            continue;
          }
          enrichedEntry = {
            ...entry,
            sessionId: meta.sessionId || entry.sessionId,
            projectPath: meta.projectPath || projectDirToPath(entry.projectDirName),
            gitBranch: meta.gitBranch || '',
            firstPrompt: meta.firstPrompt,
            summary: '',
            created: meta.created || '',
            modified: meta.modified || '',
            messageCount: meta.messageCount || 0,
          };
        }

        // Extract user messages from the JSONL file
        const userMessages = await extractUserMessages(enrichedEntry.fullPath);
        document = buildDocument(enrichedEntry, userMessages);
      }

      // Generate embedding
      const embedding = await embed(document);

      // Store in database
      upsertSession({
        session_id: enrichedEntry.sessionId,
        project_path: enrichedEntry.projectPath || '',
        git_branch: enrichedEntry.gitBranch || '',
        summary: enrichedEntry.summary || '',
        first_prompt: enrichedEntry.firstPrompt || '',
        document,
        embedding: embeddingToBuffer(embedding),
        created: enrichedEntry.created || '',
        modified: enrichedEntry.modified || '',
        message_count: enrichedEntry.messageCount || 0,
        file_mtime: fileMtime,
        indexed_at: new Date().toISOString(),
      });

      indexed++;
      const label = enrichedEntry.summary || (enrichedEntry.firstPrompt || 'untitled').slice(0, 60);
      if (onProgress) onProgress({ type: 'indexed', sessionId: enrichedEntry.sessionId, summary: label, current: indexed + skipped, total: totalEntries });
    } catch (err) {
      errors++;
      if (onProgress) onProgress({ type: 'error', message: `Failed to index ${entry.sessionId}: ${err.message}` });
    }
  }

  return { totalEntries, indexed, skipped, errors };
}
