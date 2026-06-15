import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SessionGuard } from '../auth/session.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/session.service';
import { FilesService } from './files.service';
import { parseRange } from './range';

/** RFC 5987 encoding for Content-Disposition `filename*` — keeps Vietnamese original
 *  names intact in the browser's Save dialog (AC3). Percent-encode everything outside
 *  the RFC 5987 attr-char set. */
function encodeRfc5987(name: string): string {
  return encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

@Controller('api/files')
@UseGuards(SessionGuard)
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * Mint a 15-min signed URL for one attachment, bound to the calling user (8.1).
   * Lazy-load (8.2): the FE asks for this only when a file card is opened. Permission
   * is RLS ticket-visibility; out-of-scope/not-stored → 404 (no existence leak).
   */
  @Post(':id/access-url')
  async accessUrl(@CurrentUser() user: SessionUser, @Param('id') id: string) {
    return this.files.mintAccessUrl(user, id);
  }

  /**
   * Serve an attachment via signed URL (3.7) with full HTTP Range support (8.1):
   * `206 Partial Content` for media seeking, `200` for the whole file, `416` for an
   * unsatisfiable range. Streams from disk (never buffers the whole file → AC4).
   * `?dl=1` → download with the original Vietnamese filename; otherwise inline.
   */
  @Get(':id')
  async get(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query('token') token: string,
    @Query('dl') dl: string,
    @Headers('range') rangeHeader: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.files.serve(user, id, token ?? '');

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=900');
    // Defense-in-depth for attacker-supplied attachments served inline: never let the
    // browser MIME-sniff a stored file into HTML/JS, and neutralize any active content.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");

    if (dl === '1') {
      // RFC 5987: ASCII fallback + UTF-8 original name for the download dialog (AC3).
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(file.fileName)}"; filename*=UTF-8''${encodeRfc5987(file.fileName)}`,
      );
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.fileName)}"`);
    }

    const range = parseRange(rangeHeader, file.size);

    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${file.size}`);
      res.status(416).end();
      return;
    }

    if (range) {
      const length = range.end - range.start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      res.setHeader('Content-Length', String(length));
      this.pipe(file.open(range), req, res);
      return;
    }

    res.status(200);
    res.setHeader('Content-Length', String(file.size));
    this.pipe(file.open(), req, res);
  }

  /** Pipe a file stream to the response, tearing the stream down if the client
   *  disconnects and surfacing read errors as a 500 (when headers are still open). */
  private pipe(stream: NodeJS.ReadableStream, req: Request, res: Response): void {
    req.on('close', () => {
      (stream as { destroy?: () => void }).destroy?.();
    });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500);
      res.end();
    });
    stream.pipe(res);
  }
}
