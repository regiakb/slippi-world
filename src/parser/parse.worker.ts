import { parseSlp } from "./worker";
import type { ParseMode } from "./worker";

type ParseJob = {
  id: number;
  idx: number;
  filePath: string;
  mode?: ParseMode;
};

self.onmessage = async (ev: MessageEvent<ParseJob>) => {
  const { id, idx, filePath, mode } = ev.data;
  const result = await parseSlp(filePath, mode ?? "full");
  self.postMessage({ id, idx, result });
};
