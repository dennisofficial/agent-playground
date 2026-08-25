import { Injectable } from "@nestjs/common";
import { appendFileSync, mkdirSync } from "node:fs";
import { sessionTapeDir, sessionTapeFile } from "../domain/paths.js";

@Injectable()
export class RawTapeService {
  private readonly opened = new Set<string>();

  append(engineSessionId: string, frame: unknown): void {
    try {
      if (!this.opened.has(engineSessionId)) {
        mkdirSync(sessionTapeDir(engineSessionId), { recursive: true });
        this.opened.add(engineSessionId);
      }
      appendFileSync(
        sessionTapeFile(engineSessionId),
        `${JSON.stringify(frame)}\n`,
      );
    } catch {
      // The tape is a debugging aid. Losing it must never take a turn down with it.
    }
  }
}
