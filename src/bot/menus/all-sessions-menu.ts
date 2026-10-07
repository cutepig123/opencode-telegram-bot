import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InlineKeyboard } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { logger } from "../../utils/logger.js";
import { getDateLocale, t } from "../../i18n/index.js";
import { formatSessionTitle } from "../../app/formatters/session-title-formatter.js";

export const ALL_SESSIONS_CALLBACK_PREFIX = "allsessions";
const ALL_SESSIONS_PAGE_CALLBACK_PREFIX = `${ALL_SESSIONS_CALLBACK_PREFIX}:page:`;
const MAX_BUTTON_BYTES = 64;
const ALL_SESSIONS_FETCH_LIMIT = 200;

export type AllSessionsListItem = {
  id: string;
  title?: string;
  directory: string;
  time?: {
    created?: number;
    updated?: number;
  };
};

export type AllSessionsPage = {
  sessions: AllSessionsListItem[];
  hasNext: boolean;
  page: number;
  total: number;
};

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (byteLength(value) <= maxBytes) {
    return value;
  }

  const ellipsis = "...";
  let out = value;
  while (out.length > 0 && byteLength(out + ellipsis) > maxBytes) {
    out = out.slice(0, -1);
  }
  return out + ellipsis;
}

export function parseAllSessionsPageCallback(data: string): number | null {
  if (!data.startsWith(ALL_SESSIONS_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const rawPage = data.slice(ALL_SESSIONS_PAGE_CALLBACK_PREFIX.length);
  const page = Number(rawPage);
  if (!Number.isInteger(page) || page < 0) {
    return null;
  }
  return page;
}

export function parseAllSessionsIdCallback(data: string): string | null {
  if (!data.startsWith(`${ALL_SESSIONS_CALLBACK_PREFIX}:`)) {
    return null;
  }

  if (data.startsWith(ALL_SESSIONS_PAGE_CALLBACK_PREFIX)) {
    return null;
  }

  const sessionId = data.slice(ALL_SESSIONS_CALLBACK_PREFIX.length + 1);
  return sessionId.length > 0 ? sessionId : null;
}

function normalizeWorktree(worktree: string | undefined): string {
  if (!worktree) {
    return "";
  }

  const pathModule = /^[a-zA-Z]:[\\/]|^\\\\/.test(worktree) ? path.win32 : path.posix;
  return pathModule.normalize(worktree).replace(/[\\/]+$/, "").toLowerCase();
}

export function sameWorktree(left: string | undefined, right: string | undefined): boolean {
  const a = normalizeWorktree(left);
  const b = normalizeWorktree(right);
  return a.length > 0 && a === b;
}

function dirShortName(directory: string | undefined): string {
  if (!directory) {
    return "";
  }

  const pathModule = /^[a-zA-Z]:[\\/]|^\\\\/.test(directory) ? path.win32 : path.posix;
  const parts = pathModule.normalize(directory).split(/[\\/]+/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last ?? directory;
}

function formatLastMessageTime(ms: number | undefined, locale: string): string {
  if (!ms) {
    return "";
  }

  return new Date(ms).toLocaleString(locale);
}

function buildAllSessionsButtonLabel(
  globalIndex: number,
  session: AllSessionsListItem,
  locale: string,
): string {
  const seq = `${globalIndex + 1}. `;
  const title = formatSessionTitle(session.title || session.id);
  const tail = ` [${dirShortName(session.directory)}] ${formatLastMessageTime(
    session.time?.updated ?? session.time?.created,
    locale,
  )}`;
  const base = seq + title + tail;
  if (byteLength(base) <= MAX_BUTTON_BYTES) {
    return base;
  }

  const room = Math.max(0, MAX_BUTTON_BYTES - byteLength(seq + tail));
  return seq + truncateToBytes(title, room) + tail;
}

const OPENCODE_DB_PATH =
  process.env.OPENCODE_DB_PATH || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

function discoverSessionDirectories(): string[] {
  // The /project route only reports a subset of projects, while the global SQLite DB
  // holds every session ever created, so mine it for the full directory list.
  try {
    if (!fs.existsSync(OPENCODE_DB_PATH)) {
      return [];
    }

    const db = new DatabaseSync(OPENCODE_DB_PATH, { readOnly: true });
    try {
      return db
        .prepare("SELECT DISTINCT directory FROM session WHERE directory IS NOT NULL AND directory != ''")
        .all()
        .map((row) => row.directory as string);
    } finally {
      db.close();
    }
  } catch (error) {
    logger.warn(`[AllSessions] Could not discover directories from ${OPENCODE_DB_PATH}:`, error);
    return [];
  }
}

async function loadAllSessionsAcrossProjects(): Promise<AllSessionsListItem[]> {
  const { data: projects, error } = await opencodeClient.project.list();
  const knownWorktrees =
    !error && projects
      ? projects
          .map((p) => p.worktree)
          .filter((worktree): worktree is string => typeof worktree === "string" && worktree !== "/" && worktree.length > 0)
      : [];

  // session.list matches `directory` by exact string (drive letter case and
  // path separators matter), so query every distinct path verbatim and dedupe by id.
  const directories = Array.from(new Set([...knownWorktrees, ...discoverSessionDirectories()]));
  if (directories.length === 0) {
    throw new Error("No session directories found");
  }

  const byId = new Map<string, AllSessionsListItem>();
  await Promise.all(
    directories.map(async (directory) => {
      const { data: sessions, error: listError } = await opencodeClient.session.list({
        directory,
        limit: ALL_SESSIONS_FETCH_LIMIT,
        roots: true,
      });

      if (listError || !sessions) {
        logger.warn(`[AllSessions] Failed to list sessions for ${directory}:`, listError);
        return;
      }

      for (const session of sessions as unknown as AllSessionsListItem[]) {
        if (!byId.has(session.id)) {
          byId.set(session.id, session);
        }
      }
    }),
  );

  return Array.from(byId.values()).sort((a, b) => {
    const aUpdated = a.time?.updated ?? a.time?.created ?? 0;
    const bUpdated = b.time?.updated ?? b.time?.created ?? 0;
    if (bUpdated !== aUpdated) {
      return bUpdated - aUpdated;
    }
    return (b.time?.created ?? 0) - (a.time?.created ?? 0);
  });
}

export async function loadAllSessionsPage(page: number, pageSize: number): Promise<AllSessionsPage> {
  const all = await loadAllSessionsAcrossProjects();
  const startIndex = page * pageSize;
  const sessions = all.slice(startIndex, startIndex + pageSize);

  return {
    sessions,
    hasNext: startIndex + pageSize < all.length,
    page,
    total: all.length,
  };
}

export function buildAllSessionsMenuView(
  pageData: AllSessionsPage,
  pageSize: number,
): { text: string; keyboard: InlineKeyboard } {
  const keyboard = new InlineKeyboard();
  const pageStartIndex = pageData.page * pageSize;
  const localeForDate = getDateLocale();

  pageData.sessions.forEach((session, index) => {
    keyboard
      .text(
        buildAllSessionsButtonLabel(pageStartIndex + index, session, localeForDate),
        `${ALL_SESSIONS_CALLBACK_PREFIX}:${session.id}`,
      )
      .row();
  });

  if (pageData.page > 0) {
    keyboard.text(t("sessions.button.prev_page"), `${ALL_SESSIONS_PAGE_CALLBACK_PREFIX}${pageData.page - 1}`);
  }

  if (pageData.hasNext) {
    keyboard.text(t("sessions.button.next_page"), `${ALL_SESSIONS_PAGE_CALLBACK_PREFIX}${pageData.page + 1}`);
  }

  if (pageData.page > 0 || pageData.hasNext) {
    keyboard.row();
  }

  return {
    text: t("allsessions.select_page", { page: pageData.page + 1, total: pageData.total }),
    keyboard,
  };
}
