import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";

function messageOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === "string") return body;
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join(" ");
  return typeof message === "string" ? message : exception.message;
}

// The front reads `corpo.erro` from every failed response.
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    if (exception instanceof HttpException) {
      if (!res.headersSent) res.status(exception.getStatus()).json({ erro: messageOf(exception) });
      return;
    }

    const message = exception instanceof Error ? exception.message : String(exception);
    console.error(`[${req.method} ${req.originalUrl}] falha: ${message}`);
    if (!res.headersSent) res.status(500).json({ erro: message });
  }
}
