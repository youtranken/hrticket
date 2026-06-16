import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ErrorCode } from '@hris/shared';

/**
 * Global HTTP exception filter. Two jobs:
 *  - A `ZodError` from a `.parse()` at a controller boundary becomes a clean 400
 *    (VALIDATION_FAILED) instead of leaking as an unhandled 500 (M3).
 *  - A truly unexpected error is logged server-side and answered with a sanitized 500
 *    (INTERNAL) that never leaks a stack trace or internal message to the client.
 * Nest `HttpException`s pass through UNCHANGED so the existing response shape that the
 * FE already reads is preserved.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ZodError) {
      res.status(400).json({
        statusCode: 400,
        error: 'Bad Request',
        code: ErrorCode.VALIDATION_FAILED,
        message: 'Invalid payload',
        details: exception.issues,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json(typeof body === 'string' ? { statusCode: status, message: body } : body);
      return;
    }

    // Unexpected: log the real error server-side, answer with a generic 500.
    this.logger.error(
      exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
    );
    res.status(500).json({
      statusCode: 500,
      error: 'Internal Server Error',
      code: ErrorCode.INTERNAL,
      message: 'Internal server error',
    });
  }
}
