declare module "busboy" {
  import { IncomingHttpHeaders } from "http";
  import { Readable } from "stream";

  interface BusboyConfig {
    headers: IncomingHttpHeaders;
    limits?: { fileSize?: number; files?: number };
  }

  interface FileInfo {
    filename: string;
    encoding: string;
    mimeType: string;
  }

  class Busboy extends Readable {
    write(chunk: any, cb?: (error?: Error | null) => void): boolean;
    on(event: "field", listener: (name: string, value: string) => void): this;
    on(event: "file", listener: (name: string, stream: Readable, info: FileInfo) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "error", listener: (err: unknown) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  function busboy(config: BusboyConfig): Busboy;
  export default busboy;
}
