declare module '@vercel/node' {
  import type { IncomingMessage, ServerResponse } from 'http';

  export interface VercelRequest extends IncomingMessage {
    query: { [key: string]: string | string[] | undefined };
    cookies: { [key: string]: string | undefined };
    body: any;
  }

  export interface VercelResponse extends ServerResponse {
    status(statusCode: number): this;
    send(body: any): this;
    json(jsonBody: any): this;
    redirect(url: string): this;
    redirect(status: number, url: string): this;
  }
}
