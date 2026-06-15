import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpException,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { ProjectContextService } from '../auth/project-context.service';
import { ExportService, ExportTooLargeError, type ExportFormat, type ExportTable } from './export.service';
import { exportTicketsSchema, exportReportSchema, asTicketListQuery } from './dto/export.body';

/**
 * Export endpoints (Story 10.4, FR84). Ticket export rides on the worklist's RLS
 * (any session user; only their visible tickets land in the file). Report export
 * is TL/admin/ssa only (mirrors 10.3). Over 10k rows → 422, no partial file.
 */
@Controller('api/export')
@UseGuards(SessionGuard)
export class ExportController {
  constructor(
    private readonly svc: ExportService,
    private readonly projectCtx: ProjectContextService,
  ) {}

  @Post('tickets')
  async tickets(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = exportTicketsSchema.parse(body);
    const filter = asTicketListQuery(parsed.filter);
    try {
      const table = await this.svc.ticketsTable(user, filter, parsed.lang);
      await this.send(res, table, parsed.format);
    } catch (e) {
      this.mapError(e);
    }
  }

  @Post('report')
  async report(
    @CurrentUser() user: SessionUser,
    @Body() body: unknown,
    @Headers('x-project') xp: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const parsed = exportReportSchema.parse(body);
    if (user.role === 'member') throw new ForbiddenException();
    const project = await this.projectCtx.resolveEffective(user, xp);
    try {
      const table = await this.svc.reportTable(
        user,
        project.id,
        parsed.kind,
        { from: parsed.from, to: parsed.to },
        parsed.lang,
      );
      await this.send(res, table, parsed.format);
    } catch (e) {
      this.mapError(e);
    }
  }

  /** Stream the serialized file with the right content-type + download name. */
  private async send(res: Response, table: ExportTable, format: ExportFormat): Promise<void> {
    if (format === 'csv') {
      const buf = this.svc.toCsv(table);
      res
        .status(HttpStatus.OK)
        .setHeader('Content-Type', 'text/csv; charset=utf-8')
        .setHeader('Content-Disposition', `attachment; filename="${table.baseName}.csv"`)
        .send(buf);
      return;
    }
    const buf = await this.svc.toXlsx(table);
    res
      .status(HttpStatus.OK)
      .setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .setHeader('Content-Disposition', `attachment; filename="${table.baseName}.xlsx"`)
      .send(buf);
  }

  private mapError(e: unknown): never {
    if (e instanceof ExportTooLargeError) {
      throw new HttpException(
        { code: 'EXPORT_TOO_LARGE', message: 'reports.export.tooLarge', details: { limit: e.limit } },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    throw e;
  }
}
