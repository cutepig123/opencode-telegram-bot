import type { Context } from "grammy";
import { opencodeClient } from "../../opencode/client.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { getCurrentProject, setCurrentProject } from "../../app/stores/settings-store.js";
import type { ProjectInfo } from "../../app/types/project.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { appendInlineMenuCancelButton, ensureActiveInlineMenu } from "../menus/inline-menu.js";
import {
  ALL_SESSIONS_CALLBACK_PREFIX,
  parseAllSessionsIdCallback,
  parseAllSessionsPageCallback,
  buildAllSessionsMenuView,
  loadAllSessionsPage,
  sameWorktree,
} from "../menus/all-sessions-menu.js";
import { selectSessionById, type SessionSelectDeps } from "./session-callback-handler.js";
import { failure } from "./feedback.js";

async function resolveProjectForWorktree(worktree: string): Promise<ProjectInfo> {
  const { data: projects } = await opencodeClient.project.list();
  const match = (projects || []).find((p) => p.worktree && sameWorktree(p.worktree, worktree));
  if (match) {
    return { id: match.id, worktree: match.worktree, name: match.name || match.worktree };
  }

  const suffix = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  const fallbackId = `dir_${Buffer.from(String(Date.now())).toString("hex")}${suffix}`;
  const baseName = worktree.split(/[\\/]/).filter(Boolean).pop() || worktree;
  return { id: fallbackId, worktree, name: baseName };
}

async function ensureProjectForSession(sessionId: string): Promise<void> {
  const { data: session, error } = await opencodeClient.session.get({ sessionID: sessionId });
  if (error || !session) {
    throw error || new Error("Failed to get session details");
  }

  const worktree = session.directory;
  if (!worktree) {
    return;
  }

  const currentProject = getCurrentProject();
  if (currentProject && sameWorktree(currentProject.worktree, worktree)) {
    return;
  }

  const project = await resolveProjectForWorktree(worktree);
  // Keep the session's exact directory as the working tree so the session
  // lookup inside selectSessionById resolves against the right project.
  setCurrentProject({ ...project, worktree });
  logger.info(`[AllSessions] Current project set to ${worktree} (id=${project.id}) for session ${sessionId}`);
}

export async function handleAllSessionsCallback(ctx: Context, deps: SessionSelectDeps): Promise<boolean> {
  const data = ctx.callbackQuery?.data;
  if (!data || !data.startsWith(`${ALL_SESSIONS_CALLBACK_PREFIX}:`)) {
    return false;
  }

  if (isForegroundBusy(deps)) {
    await replyBusyBlocked(ctx);
    return true;
  }

  const isActiveMenu = await ensureActiveInlineMenu(ctx, "allsessions", deps);
  if (!isActiveMenu) {
    return true;
  }

  const page = parseAllSessionsPageCallback(data);
  if (page !== null) {
    try {
      const pageSize = config.bot.sessionsListLimit;
      const pageData = await loadAllSessionsPage(page, pageSize);
      if (pageData.sessions.length === 0) {
        await ctx.answerCallbackQuery({ text: t("allsessions.page_empty_callback") });
        return true;
      }

      const { text, keyboard } = buildAllSessionsMenuView(pageData, pageSize);
      appendInlineMenuCancelButton(keyboard, "allsessions");
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(text, {
        reply_markup: keyboard,
      });
    } catch (error) {
      logger.error("[AllSessions] Error loading sessions page:", error);
      await ctx.answerCallbackQuery({ text: t("allsessions.page_load_error_callback") }).catch(() => {});
    }

    return true;
  }

  const sessionId = parseAllSessionsIdCallback(data);
  if (!sessionId) {
    await ctx.answerCallbackQuery({ text: t("callback.processing_error") });
    return true;
  }

  try {
    await ensureProjectForSession(sessionId);
    await selectSessionById(ctx, deps, sessionId, {
      source: "all_sessions_menu",
      deleteCallbackMessage: true,
      removeCallbackReplyMarkup: false,
      postSelectAction: "preview",
    });
  } catch (error) {
    logger.error("[AllSessions] Error selecting session:", error);
    await failure(ctx, "allsessions.open_error").catch(() => {});
  }

  return true;
}
