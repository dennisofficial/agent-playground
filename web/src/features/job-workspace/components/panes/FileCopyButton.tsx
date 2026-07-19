import { ContextFileContent } from "@/lib/api/types";
import { Check, Copy } from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { TopBarButton } from "../chrome/detail-top-bar";
import { fileCopyKind, fileDataUrl, imageDataUrlToPngBlob } from "./step-view";

export function FileCopyButton({ file }: { file: ContextFileContent | undefined }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const kind = file ? fileCopyKind(file.mime) : null;
  if (!file || !kind) return null;

  async function copy() {
    if (!file || !kind) return;
    try {
      if (kind === 'image') {
        const pngBlob = await imageDataUrlToPngBlob(fileDataUrl(file));
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      } else {
        const text = file.encoding === 'base64' ? atob(file.content) : file.content;
        await navigator.clipboard.writeText(text);
      }
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error('Copy failed', err);
    }
  }

  return (
    <TopBarButton
      title={copied ? 'Copied' : kind === 'image' ? 'Copy image' : 'Copy file'}
      onClick={copy}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </TopBarButton>
  );
}
