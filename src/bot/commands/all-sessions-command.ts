import { CommandContext, Context } from "grammy";
import type { AppContainer } from "../../app/bootstrap/app-container.js";
import { config } from "../../config.js";
import { t } from "../../i18n/index.js";
import { logger } from "../../utils/logger.js";
import { isForegroundBusy } from "../../app/services/run-control-service.js";
import { replyBusyBlocked } from "../messages/busy-blocked-renderer.js";
import { replyWithInlineMenu } from "../menus/inline-menu.js";
import { buildAllSessionsMenuView, loadAllSessionsPage } from "../menus/all-sessions-menu.js";

export type AllSessionsCommandDeps = Pick<
  AppContainer,
  "attachManager" | "foregroundSessionState" | "interactionManager"
>;

export async function allSessionsCommand(
  ctx: CommandContext<Context>,
  deps: AllSessionsCommandDeps,
): Promise<void> {
  try {
    if (isForegroundBusy(deps)) {
      await replyBusyBlocked(ctx);
      return;
    }

    const pageSize = config.bot.sessionsListLimit;
    const pageData = await loadAllSessionsPage(0, pageSize);

    logger.info(`[AllSessions] Fetched ${pageData.total} sessions across all projects`);

    if (pageData.sessions.length === 0) {
      await ctx.reply(t("allsessions.empty"));
      return;
    }

    const { text, keyboard } = buildAllSessionsMenuView(pageData, pageSize);

    await replyWithInlineMenu(
      ctx,
      {
        menuKind: "allsessions",
        text,
        keyboard,
        metadata: { page: 0 },
      },
      deps,
    );
  } catch (error) {
    logger.error("[AllSessions] Error fetching sessions:", error);
    await ctx.reply(t("allsessions.fetch_error"));
  }
}
