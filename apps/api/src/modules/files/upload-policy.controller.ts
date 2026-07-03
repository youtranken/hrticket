import { Controller, Get, Headers, UseGuards } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { withActor, systemActor } from '../../infra/db/with-actor';
import { projectSettings } from '../../infra/db/schema';

/**
 * Read-only upload policy for the FE attachment pickers (compose / manual ticket).
 * Any authenticated role may read it — the FE must gate with the SAME config the
 * admin edits in /admin/attachments instead of hardcoding a copy; the admin-gated
 * /admin/attachment-config stays the only WRITE surface and the upload service
 * re-enforces these limits server-side on every store.
 */
@Controller('api/upload-policy')
@UseGuards(SessionGuard)
export class UploadPolicyController {
  constructor(private readonly projectCtx: ProjectContextService) {}

  @Get()
  async get(@CurrentUser() user: SessionUser, @Headers('x-project') xp?: string) {
    const p = await this.projectCtx.resolveEffective(user, xp);
    return withActor(systemActor, async (tx) => {
      const [row] = await tx
        .select({
          allowedExtensions: projectSettings.allowedExtensions,
          capMb: projectSettings.attachmentCapMb,
        })
        .from(projectSettings)
        .where(eq(projectSettings.projectId, p.id));
      // Same fallbacks the upload service applies when the settings row is missing.
      return { allowedExtensions: row?.allowedExtensions ?? [], capMb: row?.capMb ?? 50 };
    });
  }
}
