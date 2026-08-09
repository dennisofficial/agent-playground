import { Injectable } from "@nestjs/common";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  CONTEXT_BUCKETS,
  jobContextDir,
  type ContextBucket,
} from "../domain/paths.js";

export type ContextEntry = {
  bucket: ContextBucket;
  path: string;
  bytes: number;
  modifiedAt: Date;
  isDirectory: boolean;
};

@Injectable()
export class ContextFolderService {
  ensure(jobId: string): string {
    const root = jobContextDir(jobId);
    for (const bucket of CONTEXT_BUCKETS) {
      mkdirSync(join(root, bucket), { recursive: true });
    }
    return root;
  }

  root(jobId: string): string {
    return jobContextDir(jobId);
  }

  list(jobId: string): ContextEntry[] {
    const root = this.ensure(jobId);
    return CONTEXT_BUCKETS.flatMap((bucket) =>
      this.walk(root, bucket, join(root, bucket), ""),
    );
  }

  resolveInside(jobId: string, relativePath: string): string {
    const root = resolve(this.root(jobId));
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`path escapes the job context folder: ${relativePath}`);
    }
    return target;
  }

  private walk(
    root: string,
    bucket: ContextBucket,
    dir: string,
    prefix: string,
  ): ContextEntry[] {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }

    return entries.flatMap((name) => {
      const absolute = join(dir, name);
      const path = prefix ? join(prefix, name) : name;
      const stats = statSync(absolute);
      const entry: ContextEntry = {
        bucket,
        path,
        bytes: stats.size,
        modifiedAt: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
      return stats.isDirectory()
        ? [entry, ...this.walk(root, bucket, absolute, path)]
        : [entry];
    });
  }
}

export function contextMentionLabel(entry: ContextEntry): string {
  return `context/${entry.bucket}/${entry.path.split(sep).join("/")}`;
}

export function relativeToRoot(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}
